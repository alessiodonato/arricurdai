import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { toolGroup, toolLabel } from '../src/blocks';
import { parseProject, parseSession } from '../src/index';

const FIXTURE_TRANSCRIPTS = new URL('../../../fixtures/acme-shop/claude-home/projects/-home-dev-acme-shop', import.meta.url).pathname;

describe('toolGroup and toolLabel', () => {
  test('group tools by family', () => {
    expect(['Read', 'Edit', 'Write', 'Grep', 'Task', 'WebFetch', 'mcp__chrome__screenshot', 'Bash'].map(toolGroup)).toEqual([
      'Read', 'Edit/Write', 'Edit/Write', 'Grep/Glob', 'Agent', 'Web', 'MCP', 'Bash',
    ]);
  });

  test('label a call by what it worked on, never by its result', () => {
    expect(toolLabel('Read', { file_path: '/repo/src/a.ts' }, '/repo', '/repo')).toBe('Read src/a.ts');
    expect(toolLabel('Bash', { command: 'npm   run\n build' }, '/repo', '/repo')).toBe('Bash: npm run build');
    expect(toolLabel('Bash', { command: 'x'.repeat(100) }, '/repo', '/repo')).toHaveLength('Bash: '.length + 70);
    expect(toolLabel('WebFetch', { url: 'https://example.com/a?token=secret' }, '/repo', '/repo')).toBe('WebFetch example.com');
    expect(toolLabel('Agent', { description: 'Find orders' }, '/repo', '/repo')).toBe('Agent: Find orders');
  });
});

describe('blocks recorded by the parser', () => {
  test('session A of the fixtures: one block per prompt, memory file, attachment, reply and tool result', async () => {
    const [a] = (await parseProject(FIXTURE_TRANSCRIPTS)).sessions;
    const kinds: Record<string, number> = {};
    for (const block of a!.main.blocks) kinds[block.kind] = (kinds[block.kind] ?? 0) + 1;
    expect(kinds).toEqual({ prompt: 1, memory: 7, injected: 2, reply: 7, tool: 7 });
    expect(a!.main.blocks.filter((block) => block.kind === 'tool').map((block) => [block.turn, block.label])).toEqual([
      [2, 'Read src/checkout.ts'],
      [3, 'Bash: grep -rn "applyDiscount" src'],
      [3, 'Bash: cat package.json'],
      [4, "Bash: sed -n '1,40p' src/pricing.ts"],
      [5, "Bash: find src -name '*.test.ts'"],
      [6, 'Read src/cart.ts'],
      [7, 'Edit src/cart.ts'],
    ]);
    // A reply enters the context at the call after the one that wrote it.
    expect(a!.main.blocks.filter((block) => block.kind === 'reply').map((block) => block.turn)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  test('synthetic replies are not API calls, thinking and images are counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-blocks-'));
    const usage = (extra: object = {}) => ({ input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, ...extra });
    const png = Buffer.alloc(33);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(750, 16);
    png.writeUInt32BE(750, 20);
    const lines = [
      { type: 'assistant', cwd: '/repo', message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'mcp__browser__screenshot', input: {} }], usage: usage({ output_tokens_details: { thinking_tokens: 40 } }) } },
      { type: 'user', cwd: '/repo', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] }] } },
      { type: 'assistant', cwd: '/repo', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ];
    try {
      writeFileSync(join(dir, 's.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
      const session = await parseSession({ sessionId: 's', file: join(dir, 's.jsonl'), subagents: [] });
      expect(session.main.calls).toHaveLength(1);
      expect(session.stats.ignored).toBe(1);
      const thinking = session.main.blocks.find((block) => block.kind === 'thinking');
      expect(thinking).toMatchObject({ fixedTokens: 40, turn: 2 });
      // 750 · 750 / 750 tokens of image, besides the text
      expect(session.main.blocks.find((block) => block.kind === 'tool')).toMatchObject({ group: 'MCP', fixedTokens: 750, turn: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
