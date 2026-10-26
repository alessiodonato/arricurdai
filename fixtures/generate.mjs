// Generates the synthetic "acme-shop" fixtures described in fixtures/README.md.
// Run with: node fixtures/generate.mjs
// Every line is invented and imitates docs/transcript-schema.md. Nothing comes from a real transcript.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'acme-shop');
const CWD = '/home/dev/acme-shop';
const HOME = '/home/dev';
const VERSION = '2.1.310';
const PROJECT_KEY = '-home-dev-acme-shop';
const TRANSCRIPTS = join(ROOT, 'claude-home', 'projects', PROJECT_KEY);

rmSync(ROOT, { recursive: true, force: true });

// ---------------------------------------------------------------- project files

const FILES = {
  'CLAUDE.md': `# Acme Shop

- Run the tests with \`pnpm test\`.
- Prices and tax rules live in \`src/pricing.ts\`; never hardcode a tax rate.
- Database access goes through \`src/db/orders.ts\`.
- Deploy with \`scripts/deploy.sh --prod\` from the main branch only.
- The legacy \`oldCheckout()\` helper is deprecated; do not call it.
- Keep commit messages short and in the imperative mood.

See @docs/conventions.md for code style.
`,
  'docs/conventions.md': `# Conventions

- Validate request bodies with \`zod\` at API boundaries.
- Money is stored in integer cents; see \`toCents()\` in \`src/pricing.ts\`.
`,
  '.claude/CLAUDE.md': `- Never edit generated files under \`src/generated/\`.
`,
  '.claude/rules/testing.md': `# Testing

- Tests sit next to the code as \`*.test.ts\` files.
`,
  'CLAUDE.local.md': `- My local database listens on port 5433 (\`docker compose up db\`).
`,
  'src/db/CLAUDE.md': `- Queries must use the \`withTransaction()\` wrapper from \`src/db/tx.ts\`.
`,
  'package.json': `{
  "name": "acme-shop",
  "private": true,
  "scripts": { "test": "vitest run" }
}
`,
  'src/checkout.ts': `import { applyDiscount, toCents } from './pricing'
import type { Cart } from './cart'

export function computeTotals(cart: Cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const discounted = applyDiscount(subtotal, cart.coupon)
  return { subtotal: toCents(subtotal), total: toCents(discounted) }
}
`,
  'src/cart.ts': `export type CartItem = { sku: string; price: number; qty: number }
export type Cart = { items: CartItem[]; coupon?: string }

export function addItem(cart: Cart, item: CartItem): Cart {
  return { ...cart, items: [...cart.items, item] }
}
`,
  'src/db/orders.ts': `import { db } from './client'

export async function listOrders(customerId: string) {
  return db.query('select * from orders where customer_id = $1', [customerId])
}
`,
};

const PRICING_BEFORE = `export const TAX_RATE = 0.22

export function toCents(amount: number) {
  return Math.round(amount * 100)
}

export function applyDiscount(amount: number, coupon?: string) {
  if (coupon === 'WELCOME10') return amount * 0.9
  return amount
}
`;
const PRICING_AFTER = PRICING_BEFORE.replace(
  "  if (coupon === 'WELCOME10') return amount * 0.9\n",
  "  if (coupon === 'WELCOME10') return amount * 0.9\n  if (amount > 100) return amount * 0.9\n",
);
const CART_AFTER = FILES['src/cart.ts'] + `
export function removeItem(cart: Cart, sku: string): Cart {
  return { ...cart, items: cart.items.filter((item) => item.sku !== sku) }
}
`;

const USER_CLAUDE_MD = `- Answer in English, briefly.
`;
const MEMORY_MD = `- [Checkout flow](checkout-flow.md) — totals are computed in \`computeTotals()\` in \`src/checkout.ts\`
- [Billing webhooks](billing.md) — Stripe events arrive in \`src/billing/webhook.ts\`
`;
const MEMORY_TOPIC = `Webhook secrets are rotated by hand every quarter.
`;

// ---------------------------------------------------------------- helpers

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
const hash = (label) => label.padEnd(64, '0').slice(0, 64);
const numbered = (text, start = 1) =>
  text.replace(/\n$/, '').split('\n').map((line, i) => `${start + i}\t${line}`).join('\n');
const abs = (rel) => `${CWD}/${rel}`;

const MEMORY_LABELS = {
  User: "user's private global instructions for all projects",
  Project: 'project instructions, checked into the codebase',
  Local: "user's private project instructions, not checked in",
  AutoMem: "user's auto-memory, persists across conversations",
};
const memoryFiles = [
  { path: `${HOME}/.claude/CLAUDE.md`, type: 'User', content: USER_CLAUDE_MD },
  { path: abs('CLAUDE.md'), type: 'Project', content: FILES['CLAUDE.md'] },
  { path: abs('docs/conventions.md'), type: 'Project', content: FILES['docs/conventions.md'] },
  { path: abs('.claude/CLAUDE.md'), type: 'Project', content: FILES['.claude/CLAUDE.md'] },
  { path: abs('.claude/rules/testing.md'), type: 'Project', content: FILES['.claude/rules/testing.md'] },
  { path: abs('CLAUDE.local.md'), type: 'Local', content: FILES['CLAUDE.local.md'] },
  { path: `${HOME}/.claude/projects/${PROJECT_KEY}/memory/MEMORY.md`, type: 'AutoMem', content: MEMORY_MD },
].map((f) => ({ ...f, content: f.content.replace(/\n$/, '') }));

const renderedInstructions = () =>
  '<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n' +
  memoryFiles.map((f) => `Contents of ${f.path} (${MEMORY_LABELS[f.type]}):\n\n${f.content}`).join('\n\n') +
  '\n</system-reminder>';

// One session file. Conversation lines are chained through uuid/parentUuid.
class Session {
  constructor({ sessionId, start, entrypoint, agentId = null }) {
    this.sessionId = sessionId;
    this.clock = Date.parse(start);
    this.entrypoint = entrypoint;
    this.agentId = agentId;
    this.lines = [];
    this.parent = null;
    this.calls = []; // usage of every distinct API call, in order
  }

  tick(seconds = 2) {
    this.clock += seconds * 1000;
    return new Date(this.clock).toISOString();
  }

  raw(line) {
    this.lines.push(typeof line === 'string' ? line : JSON.stringify(line));
  }

  meta(fields) {
    this.raw({ ...fields, sessionId: this.sessionId });
  }

  conv(fields, { chain = true } = {}) {
    const line = {
      parentUuid: chain ? this.parent : null,
      isSidechain: this.agentId !== null,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...fields,
      uuid: uuid(),
      timestamp: this.tick(),
      userType: 'external',
      entrypoint: this.entrypoint,
      cwd: fields.cwd ?? CWD,
      sessionId: this.sessionId,
      version: VERSION,
      gitBranch: 'main',
    };
    this.parent = line.uuid;
    this.raw(line);
    return line;
  }

  prompt(text) {
    if (this.entrypoint === 'sdk-cli') {
      this.meta({ type: 'queue-operation', operation: 'enqueue', timestamp: this.tick(0), content: text });
      this.meta({ type: 'queue-operation', operation: 'dequeue', timestamp: this.tick(0) });
    }
    return this.conv({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } });
  }

  attachment(attachment, rendered) {
    return this.conv({
      type: 'attachment',
      attachment,
      ...(rendered ? { rendered: [{ content: rendered }], renderedRole: 'user' } : {}),
    });
  }

  // One API response: one line per content block, same message.id and usage on each.
  // Every tool_use block is followed by its tool_result line, as Claude Code writes them.
  call(id, usage, blocks) {
    const fullUsage = {
      input_tokens: usage.in,
      cache_creation_input_tokens: (usage.cw5m ?? 0) + (usage.cw1h ?? 0),
      cache_read_input_tokens: usage.cr,
      output_tokens: usage.out,
      output_tokens_details: { thinking_tokens: usage.thinking ?? 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: usage.cw1h ?? 0, ephemeral_5m_input_tokens: usage.cw5m ?? 0 },
      inference_geo: 'global',
      iterations: [{
        input_tokens: usage.in,
        output_tokens: usage.out,
        cache_read_input_tokens: usage.cr,
        cache_creation_input_tokens: (usage.cw5m ?? 0) + (usage.cw1h ?? 0),
        cache_creation: { ephemeral_5m_input_tokens: usage.cw5m ?? 0, ephemeral_1h_input_tokens: usage.cw1h ?? 0 },
        type: 'message',
      }],
      speed: 'standard',
      fallback_credit: null,
    };
    this.calls.push(fullUsage);
    if (!this.agentId) {
      this.meta({
        type: 'api-request', timestamp: this.tick(0), id: uuid(), base: null,
        tail: [hash(`${id}-tail`)], keep: 0, params: { model: 'claude-sonnet-5-5' }, querySource: 'repl_main_thread',
        version: VERSION,
      });
    }
    blocks.forEach((block, index) => {
      const content = block.type === 'tool_use'
        ? [{ type: 'tool_use', id: block.id, name: block.name, input: block.input, caller: { type: 'direct' } }]
        : [block];
      const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      const line = {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5-5', id, type: 'message', role: 'assistant', content,
          container: null, stop_reason: stop, stop_sequence: null, stop_details: null,
          usage: fullUsage, input_transformations: [], diagnostics: null, context_management: null,
        },
        apiBlockIndex: index,
        requestId: `req_${id.slice(4)}`,
      };
      if (block.type === 'tool_use' && block.wireCwd) line.wireIngestContext = { [block.id]: { cwd: block.wireCwd } };
      this.conv(line);
      if (block.type === 'tool_use') this.toolResult(block);
    });
  }

  toolResult(block) {
    const { result } = block;
    const content = result.blocks ?? result.text;
    this.conv({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: block.id, type: 'tool_result', content, ...(result.isError ? { is_error: true } : {}) }] },
      toolUseResult: result.toolUseResult,
      sourceToolAssistantUUID: this.parent,
    });
  }

  costState(extra = { in: 0, cw: 0, cr: 0, out: 0 }, also = []) {
    const all = [...this.calls, ...also];
    const sum = (f) => all.reduce((acc, u) => acc + f(u), 0);
    this.meta({
      type: 'cost-state',
      totalCostUSD: 0,
      modelUsage: {
        'claude-sonnet-5-5': {
          inputTokens: sum((u) => u.input_tokens) + extra.in,
          outputTokens: sum((u) => u.output_tokens) + extra.out,
          thinkingTokens: 0,
          cacheReadInputTokens: sum((u) => u.cache_read_input_tokens) + extra.cr,
          cacheCreationInputTokens: sum((u) => u.cache_creation_input_tokens) + extra.cw,
          webSearchRequests: 0,
          costUSD: 0,
        },
      },
      hasUnknownModelCost: false,
    });
  }

  write(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.lines.join('\n') + '\n');
  }
}

// Tool call builders. Results are what the model saw (tool_result content).
const read = (id, rel, text, { start = 1 } = {}) => ({
  type: 'tool_use', id, name: 'Read',
  input: { file_path: abs(rel), offset: start, limit: 200 },
  result: {
    text: numbered(text, start),
    toolUseResult: {
      type: 'text',
      file: { filePath: abs(rel), content: text, numLines: text.split('\n').length - 1, startLine: start, totalLines: text.split('\n').length - 1 },
    },
  },
});
const bash = (id, command, stdout, extra = {}) => ({
  type: 'tool_use', id, name: 'Bash',
  input: { command, description: extra.description ?? 'Run command' },
  wireCwd: extra.wireCwd,
  result: {
    text: extra.resultText ?? stdout,
    isError: extra.isError,
    toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...(extra.toolUseResult ?? {}) },
  },
});
const edit = (id, rel, oldString, newString, original) => ({
  type: 'tool_use', id, name: 'Edit',
  input: { file_path: abs(rel), old_string: oldString, new_string: newString, replace_all: false },
  result: {
    text: `The file ${abs(rel)} has been updated successfully.`,
    toolUseResult: { filePath: abs(rel), oldString, newString, originalFile: original, structuredPatch: [], userModified: false, replaceAll: false },
  },
});
const text = (t) => ({ type: 'text', text: t });
const thinking = (t) => ({ type: 'thinking', thinking: t, signature: 'fixture-signature' });

const GREP_OUT = 'src/checkout.ts:1:import { applyDiscount, toCents } from \'./pricing\'\n' +
  'src/checkout.ts:6:  const discounted = applyDiscount(subtotal, cart.coupon)\n' +
  'src/pricing.ts:7:export function applyDiscount(amount: number, coupon?: string) {';

// ---------------------------------------------------------------- session A
// 2026-09-01, interactive. Explores checkout, then edits cart.ts.

const A = new Session({ sessionId: '11111111-1111-4111-8111-111111111111', start: '2026-09-01T09:00:00.000Z', entrypoint: 'cli' });
A.meta({ type: 'mode', mode: 'normal' });
A.prompt('How does checkout compute the totals? Then add a removeItem helper to the cart.');
A.attachment({ type: 'instructions', files: memoryFiles }, renderedInstructions());
A.attachment({ type: 'session_context', context: { gitStatus: 'Current branch: main\n\nStatus:\n(clean)' } },
  '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# gitStatus\nCurrent branch: main\n</system-reminder>');
A.attachment({ type: 'date', date: '2026-09-01' }, '<system-reminder>\nToday\'s date is 2026-09-01.\n</system-reminder>');
A.meta({ type: 'api-request-shape', timestamp: A.tick(0), shapeHash: hash('shape-a'), shape: { system: [{ type: 'text', text: 'You are a coding agent (fixture).' }], tools: [{ name: 'Read' }, { name: 'Bash' }, { name: 'Edit' }, { name: 'Agent' }] }, version: VERSION });
A.call('msg_fx_A1', { in: 3, cw1h: 12000, cr: 0, out: 180 }, [
  thinking('Start from the checkout module.'),
  text('Let me read the checkout code.'),
  read('toolu_fx_A1', 'src/checkout.ts', FILES['src/checkout.ts']),
]);
A.call('msg_fx_A2', { in: 1, cw1h: 1500, cr: 12000, out: 120 }, [
  bash('toolu_fx_A2a', 'grep -rn "applyDiscount" src', GREP_OUT, { description: 'Find discount usages' }),
  bash('toolu_fx_A2b', 'cat package.json', FILES['package.json'].replace(/\n$/, '')),
]);
A.call('msg_fx_A3', { in: 1, cw1h: 900, cr: 13500, out: 90 }, [
  bash('toolu_fx_A3', "sed -n '1,40p' src/pricing.ts", PRICING_BEFORE.replace(/\n$/, '')),
]);
A.call('msg_fx_A4', { in: 1, cw1h: 700, cr: 14400, out: 150 }, [
  bash('toolu_fx_A4', "find src -name '*.test.ts'", 'src/checkout.test.ts\nsrc/pricing.test.ts'),
]);
A.call('msg_fx_A5', { in: 1, cw1h: 800, cr: 15100, out: 90 }, [
  read('toolu_fx_A5', 'src/cart.ts', FILES['src/cart.ts']),
]);
A.call('msg_fx_A6', { in: 1, cw1h: 500, cr: 15900, out: 260 }, [
  edit('toolu_fx_A6', 'src/cart.ts', '  return { ...cart, items: [...cart.items, item] }\n}\n',
    '  return { ...cart, items: [...cart.items, item] }\n}\n\nexport function removeItem(cart: Cart, sku: string): Cart {\n  return { ...cart, items: cart.items.filter((item) => item.sku !== sku) }\n}\n',
    FILES['src/cart.ts']),
]);
A.call('msg_fx_A7', { in: 1, cw1h: 400, cr: 16400, out: 350 }, [
  text('`computeTotals()` in `src/checkout.ts` sums the items, applies `applyDiscount()` from `src/pricing.ts` and converts to cents. I added `removeItem()` to `src/cart.ts`.'),
]);
A.conv({ type: 'system', subtype: 'turn_duration', durationMs: 41000, messageCount: 14, isMeta: false });
A.meta({ type: 'ai-title', aiTitle: 'Checkout totals and removeItem' });
A.meta({ type: 'last-prompt', lastPrompt: 'How does checkout compute the totals?', leafUuid: A.parent });
A.costState();
A.write(join(TRANSCRIPTS, `${A.sessionId}.jsonl`));

// ---------------------------------------------------------------- session B
// 2026-09-02, headless. Re-reads known files, runs a subagent, hits a large output, edits pricing.ts.

const B = new Session({ sessionId: '22222222-2222-4222-8222-222222222222', start: '2026-09-02T10:00:00.000Z', entrypoint: 'sdk-cli' });
B.prompt('Give a 10% discount on orders over 100, and check how orders are queried.');
B.attachment({ type: 'instructions', files: memoryFiles }, renderedInstructions());
B.attachment({ type: 'total_tokens_reminder', remaining: 1000000, used: 0, total: 1000000 }, '<system-reminder>\n<total_tokens>1000000 tokens left</total_tokens>\n</system-reminder>');
B.call('msg_fx_B1', { in: 3, cw1h: 12500, cr: 0, out: 140 }, [
  read('toolu_fx_B1', 'src/checkout.ts', FILES['src/checkout.ts']),
]);
B.call('msg_fx_B2', { in: 1, cw1h: 600, cr: 12500, out: 100 }, [
  read('toolu_fx_B2', 'src/pricing.ts', PRICING_BEFORE),
]);
B.call('msg_fx_B3', { in: 1, cw1h: 500, cr: 13100, out: 90 }, [
  bash('toolu_fx_B3', 'grep -rn "applyDiscount" src', GREP_OUT, { description: 'Find discount usages' }),
]);
B.call('msg_fx_B4', { in: 1, cw1h: 700, cr: 13600, out: 110 }, [
  read('toolu_fx_B4', 'src/cart.ts', CART_AFTER),
]);
const AGENT_ID = 'a1b2c3d4e5f6a7b8c';
B.call('msg_fx_B5', { in: 1, cw1h: 400, cr: 14300, out: 160 }, [{
  type: 'tool_use', id: 'toolu_fx_B5', name: 'Agent',
  input: { description: 'Find order queries', subagent_type: 'Explore', prompt: 'Find where orders are queried in the database layer and report the functions.' },
  result: {
    blocks: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${AGENT_ID}\nYou will get a completion notification.` }],
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_ID, description: 'Find order queries', prompt: 'Find where orders are queried in the database layer and report the functions.', outputFile: `/tmp/fixture/${AGENT_ID}.output`, canReadOutputFile: false, canContinueAgent: true, resolvedModel: 'claude-sonnet-5-5' },
  },
}]);
const LOG = Array.from({ length: 800 }, (_, i) =>
  `2026-09-01T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO order ${10000 + i} paid total=${(i * 7) % 300}.00 EUR`).join('\n');
const PERSISTED_ID = 'k3x9q2m7p';
const PERSISTED_PATH = `${HOME}/.claude/projects/${PROJECT_KEY}/${B.sessionId}/tool-results/${PERSISTED_ID}.txt`;
const PREVIEW = LOG.slice(0, 2000);
B.call('msg_fx_B6', { in: 1, cw1h: 900, cr: 14700, out: 120 }, [
  bash('toolu_fx_B6', 'cat logs/app.log', LOG.slice(0, 30000), {
    description: 'Show the application log',
    resultText: `<persisted-output>\nOutput too large (${Math.round(LOG.length / 1024)}KB). Full output saved to: ${PERSISTED_PATH}\n\nPreview (first 2KB):\n${PREVIEW}\n...\n</persisted-output>`,
    toolUseResult: { persistedOutputPath: PERSISTED_PATH, persistedOutputSize: LOG.length },
  }),
]);
B.call('msg_fx_B7', { in: 1, cw1h: 300, cr: 15600, out: 210 }, [
  edit('toolu_fx_B7', 'src/pricing.ts', "  if (coupon === 'WELCOME10') return amount * 0.9\n",
    "  if (coupon === 'WELCOME10') return amount * 0.9\n  if (amount > 100) return amount * 0.9\n", PRICING_BEFORE),
]);
B.call('msg_fx_B8', { in: 1, cw1h: 250, cr: 15900, out: 80 }, [
  bash('toolu_fx_B8', 'pnpm test', ' ✓ src/pricing.test.ts (3 tests)\n ✓ src/checkout.test.ts (2 tests)\n\n Test Files  2 passed (2)', { description: 'Run the tests' }),
]);
B.meta({ type: 'queue-operation', operation: 'enqueue', timestamp: B.tick(0), content: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>toolu_fx_B5</tool-use-id>\n<status>completed</status>\n</task-notification>` });
B.meta({ type: 'queue-operation', operation: 'dequeue', timestamp: B.tick(0) });
const REPORT = 'Orders are queried only in `src/db/orders.ts`: `listOrders(customerId)` runs a parameterized select on `orders`.';
B.conv({
  type: 'user',
  message: { role: 'user', content: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>toolu_fx_B5</tool-use-id>\n<output-file>/tmp/fixture/${AGENT_ID}.output</output-file>\n<status>completed</status>\n<summary>Agent "Find order queries" completed</summary>\n<result>${REPORT}</result>\n</task-notification>` },
  origin: { kind: 'task-notification', producer: 'session-task', runId: 'fixture-run' },
});
B.call('msg_fx_B9', { in: 1, cw1h: 600, cr: 16150, out: 300 }, [
  text('Orders over 100 now get 10% off in `applyDiscount()` and the tests pass. Orders are read in `listOrders()` in `src/db/orders.ts`.'),
]);

// Subagent of session B: its own file and context, 5-minute cache writes.
const SA = new Session({ sessionId: B.sessionId, start: '2026-09-02T10:01:00.000Z', entrypoint: 'sdk-cli', agentId: AGENT_ID });
SA.conv({ type: 'user', message: { role: 'user', content: 'Find where orders are queried in the database layer and report the functions.' } });
SA.call('msg_fx_S1', { in: 2, cw5m: 6000, cr: 0, out: 90 }, [
  read('toolu_fx_S1', 'src/db/orders.ts', FILES['src/db/orders.ts']),
]);
SA.call('msg_fx_S2', { in: 1, cw5m: 300, cr: 6000, out: 60 }, [
  bash('toolu_fx_S2', 'ls src/db', 'CLAUDE.md\nclient.ts\norders.ts\ntx.ts'),
]);
SA.call('msg_fx_S3', { in: 1, cw5m: 200, cr: 6300, out: 140 }, [text(REPORT)]);
SA.write(join(TRANSCRIPTS, B.sessionId, 'subagents', `agent-${AGENT_ID}.jsonl`));

B.meta({ type: 'last-prompt', lastPrompt: 'Give a 10% discount on orders over 100', leafUuid: B.parent });
B.costState(undefined, SA.calls);
B.write(join(TRANSCRIPTS, `${B.sessionId}.jsonl`));

// ---------------------------------------------------------------- session C
// 2026-09-03, interactive. Re-reads, a cd + cat, a redirect, a compaction, and broken lines.

const C = new Session({ sessionId: '33333333-3333-4333-8333-333333333333', start: '2026-09-03T11:00:00.000Z', entrypoint: 'cli' });
C.prompt('The pricing tests fail on orders of exactly 100. Why?');
C.attachment({ type: 'instructions', files: memoryFiles }, renderedInstructions());
C.call('msg_fx_C1', { in: 3, cw1h: 12800, cr: 0, out: 150 }, [
  read('toolu_fx_C1', 'src/pricing.ts', PRICING_AFTER),
]);
C.raw('{"type":"assistant","message":{"id":"msg_fx_broken","content":[{"type":"text","te');
C.call('msg_fx_C2', { in: 1, cw1h: 500, cr: 12800, out: 100 }, [
  read('toolu_fx_C2', 'src/checkout.ts', FILES['src/checkout.ts']),
]);
C.raw('[1,2,3]');
C.raw('"not an object"');
C.raw('');
C.meta({ type: 'future-feature', payload: { note: 'a line type this parser does not know' } });
C.meta({ type: 'queue-operation', operation: 'enqueue', timestamp: C.tick(0), content: 'also check the cart' });
C.call('msg_fx_C3', { in: 1, cw1h: 300, cr: 13300, out: 90 }, [
  bash('toolu_fx_C3', 'cat src/checkout.ts > /tmp/checkout-copy.ts', ''),
]);
C.raw(JSON.stringify({ type: 'assistant', uuid: uuid(), sessionId: C.sessionId, message: { role: 'assistant', content: 'missing id and usage' } }));
C.call('msg_fx_C4', { in: 1, cw1h: 400, cr: 13600, out: 120 }, [
  bash('toolu_fx_C4', 'cd src && cat db/orders.ts', FILES['src/db/orders.ts'].replace(/\n$/, ''), { wireCwd: CWD }),
]);
C.attachment({
  type: 'nested_memory', path: abs('src/db/CLAUDE.md'), displayPath: 'src/db/CLAUDE.md',
  content: { path: abs('src/db/CLAUDE.md'), type: 'Project', content: FILES['src/db/CLAUDE.md'], contentDiffersFromDisk: false },
}, `<system-reminder>\nContents of ${abs('src/db/CLAUDE.md')}:\n\n${FILES['src/db/CLAUDE.md']}</system-reminder>`);
C.call('msg_fx_C5', { in: 1, cw1h: 350, cr: 14000, out: 180 }, [
  text('The check uses `amount > 100`, so an order of exactly 100 gets no discount.'),
]);
// /compact: the summary call writes no assistant line, only cost-state sees it.
const COMPACTION = { in: 1500, cw: 200, cr: 15000, out: 1200 };
const beforeCompact = C.parent;
C.conv({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info',
  logicalParentUuid: beforeCompact,
  compactMetadata: { trigger: 'manual', preTokens: 14530, postTokens: 2600, durationMs: 9000, cumulativeDroppedTokens: 11930 },
}, { chain: false });
C.conv({
  type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: the pricing rule uses amount > 100; orders of exactly 100 get no discount.' },
});
C.call('msg_fx_C6', { in: 3, cw1h: 2600, cr: 9000, out: 140 }, [
  read('toolu_fx_C6', 'src/checkout.ts', FILES['src/checkout.ts']),
]);
C.call('msg_fx_C7', { in: 1, cw1h: 300, cr: 11600, out: 220 }, [
  text('`computeTotals()` passes the subtotal straight to `applyDiscount()`, so the fix belongs in `src/pricing.ts`: use `amount >= 100`.'),
]);
C.conv({ type: 'system', subtype: 'turn_duration', durationMs: 52000, messageCount: 18, isMeta: false });
C.costState(COMPACTION);
C.write(join(TRANSCRIPTS, `${C.sessionId}.jsonl`));

// ---------------------------------------------------------------- files on disk

const onDisk = { ...FILES, 'src/pricing.ts': PRICING_AFTER, 'src/cart.ts': CART_AFTER };
for (const [rel, content] of Object.entries(onDisk)) {
  mkdirSync(dirname(join(ROOT, 'project', rel)), { recursive: true });
  writeFileSync(join(ROOT, 'project', rel), content);
}
writeFileSync(join(ROOT, 'claude-home', 'CLAUDE.md'), USER_CLAUDE_MD);
mkdirSync(join(TRANSCRIPTS, 'memory'), { recursive: true });
writeFileSync(join(TRANSCRIPTS, 'memory', 'MEMORY.md'), MEMORY_MD);
writeFileSync(join(TRANSCRIPTS, 'memory', 'billing.md'), MEMORY_TOPIC);
mkdirSync(join(TRANSCRIPTS, B.sessionId, 'tool-results'), { recursive: true });
writeFileSync(join(TRANSCRIPTS, B.sessionId, 'tool-results', `${PERSISTED_ID}.txt`), LOG);
writeFileSync(join(TRANSCRIPTS, B.sessionId, 'subagents', `agent-${AGENT_ID}.meta.json`), JSON.stringify({
  agentType: 'Explore', isBuiltIn: true, launchedWithDefaults: true, description: 'Find order queries',
  toolUseId: 'toolu_fx_B5', spawnDepth: 1, requestShape: 'explore', requestNonInteractive: true, finished: true,
}, null, 2) + '\n');

console.log(`fixtures written to ${ROOT}`);
