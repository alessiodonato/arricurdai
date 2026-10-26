import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { estimateTokens, sumUsage, type Usage } from '@arricurdai/core';
import { z } from 'zod';
import { listSessionFiles, type SessionFiles } from './locate';
import { classifyToolCall, readKey } from './reads';
import type { Context, FileChange, LineStats, ParsedProject, ParsedSession } from './types';

// ---------------------------------------------------------------- line schemas
// Only the fields the profiler uses. Everything else on a line is ignored.

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: z.number().nullish(),
      ephemeral_1h_input_tokens: z.number().nullish(),
    })
    .nullish(),
});

const lineFields = {
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.string().optional(),
};
const lineFieldsSchema = z.object(lineFields);
type LineFields = z.infer<typeof lineFieldsSchema>;

const assistantLine = z.object({
  ...lineFields,
  message: z.object({
    id: z.string(),
    model: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]),
    usage: usageSchema,
  }),
  wireIngestContext: z.record(z.string(), z.object({ cwd: z.string().optional() })).optional(),
});

const userLine = z.object({
  ...lineFields,
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
  toolUseResult: z.unknown().optional(),
});

const attachmentLine = z.object({ ...lineFields, attachment: z.object({ type: z.string() }) });
const memoryFile = z.object({ path: z.string(), type: z.string(), content: z.string() });
const instructionsAttachment = z.object({ files: z.array(memoryFile) });
const nestedMemoryAttachment = z.object({ content: memoryFile });

const systemLine = z.object({ ...lineFields, subtype: z.string().optional() });

const costStateLine = z.object({
  modelUsage: z.record(
    z.string(),
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadInputTokens: z.number(),
      cacheCreationInputTokens: z.number(),
    }),
  ),
});

const toolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) });
const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).nullish(),
  is_error: z.boolean().nullish(),
});

const subagentMeta = z.object({ agentType: z.string().optional(), toolUseId: z.string().optional() });

const FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit']);

/** CLAUDE.md, CLAUDE.local.md, files under a .claude folder (rules, auto memory) and MEMORY.md. */
export function isMemoryFile(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || name === 'MEMORY.md' || path.includes('/.claude/') || path.startsWith('.claude/');
}

/** Line types written by Claude Code that the profiler does not need. */
const IGNORED_TYPES = new Set([
  'queue-operation', 'api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot',
  'file-history-delta', 'last-prompt', 'ai-title', 'mode', 'permission-mode', 'atis-latch', 'summary', 'custom-title',
  'bridge-session', 'frame-link', 'artifact-comment-monitor', 'artifact-autoreact-ledger', 'agent-name',
]);

// ---------------------------------------------------------------- helpers

export function emptyLineStats(): LineStats {
  return { lines: 0, empty: 0, malformedJson: 0, notObject: 0, ignored: 0, unknownTypes: {}, invalid: {}, orphanResults: 0 };
}

export function mergeLineStats(all: LineStats[]): LineStats {
  const total = emptyLineStats();
  for (const stats of all) {
    total.lines += stats.lines;
    total.empty += stats.empty;
    total.malformedJson += stats.malformedJson;
    total.notObject += stats.notObject;
    total.ignored += stats.ignored;
    total.orphanResults += stats.orphanResults;
    for (const [type, count] of Object.entries(stats.unknownTypes)) total.unknownTypes[type] = (total.unknownTypes[type] ?? 0) + count;
    for (const [type, count] of Object.entries(stats.invalid)) total.invalid[type] = (total.invalid[type] ?? 0) + count;
  }
  return total;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The text that a tool result put into the context. Images and other blocks count as nothing. */
function resultText(content: string | unknown[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n');
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, out);
}

function toUsage(usage: z.infer<typeof usageSchema>): Usage {
  return {
    input: usage.input_tokens,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheWrite5m: usage.cache_creation?.ephemeral_5m_input_tokens ?? undefined,
    cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? undefined,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens,
  };
}

// ---------------------------------------------------------------- parser

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
  cwd: string | undefined;
  timestamp: string | undefined;
}

interface ContextState {
  context: Context;
  callIndexById: Map<string, number>;
  pending: Map<string, PendingTool>;
}

function newContext(kind: Context['kind'], agentId?: string): ContextState {
  return {
    context: {
      kind, agentId, agentType: undefined, parentToolUseId: undefined,
      calls: [], compactions: [], reads: [], memory: [], cacheTtl: '5m',
    },
    callIndexById: new Map(),
    pending: new Map(),
  };
}

class SessionParser {
  readonly stats = emptyLineStats();
  readonly main = newContext('main');
  readonly subagents = new Map<string, ContextState>();
  readonly changes: FileChange[] = [];
  readonly agentText: string[] = [];
  readonly versions = new Set<string>();
  recordsMemory = false;
  costState: Usage | undefined;
  entrypoint: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  root: string | undefined;

  /** Handlers of the line types the profiler reads. Each returns false when the line lacks fields it needs. */
  private readonly handlers: Record<string, (line: Record<string, unknown>, subagentId: string | undefined) => boolean> = {
    assistant: (line, id) => this.onAssistant(line, id),
    user: (line, id) => this.onUser(line, id),
    attachment: (line, id) => this.onAttachment(line, id),
    system: (line, id) => this.onSystem(line, id),
    'cost-state': (line) => this.onCostState(line),
  };

  constructor(root: string | undefined) {
    this.root = root;
  }

  async readFile(file: string, subagentId?: string): Promise<void> {
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) this.readLine(line, subagentId);
  }

  subagent(agentId: string): ContextState {
    let state = this.subagents.get(agentId);
    if (!state) {
      state = newContext('subagent', agentId);
      this.subagents.set(agentId, state);
    }
    return state;
  }

  private readLine(raw: string, subagentId: string | undefined): void {
    this.stats.lines++;
    if (raw.trim() === '') {
      this.stats.empty++;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.stats.malformedJson++;
      return;
    }
    if (!isRecord(value)) {
      this.stats.notObject++;
      return;
    }

    const type = typeof value.type === 'string' ? value.type : '(no type)';
    const handler = this.handlers[type];
    if (handler) {
      if (!handler(value, subagentId)) this.stats.invalid[type] = (this.stats.invalid[type] ?? 0) + 1;
    } else if (IGNORED_TYPES.has(type)) {
      this.stats.ignored++;
    } else {
      this.stats.unknownTypes[type] = (this.stats.unknownTypes[type] ?? 0) + 1;
    }
  }

  /** Records the fields every conversation line has, and returns the context the line belongs to. */
  private enter(line: LineFields, subagentId: string | undefined): ContextState {
    if (line.timestamp !== undefined) {
      if (this.startedAt === undefined || line.timestamp < this.startedAt) this.startedAt = line.timestamp;
      if (this.endedAt === undefined || line.timestamp > this.endedAt) this.endedAt = line.timestamp;
    }
    if (line.version) this.versions.add(line.version);
    if (line.entrypoint && subagentId === undefined) this.entrypoint ??= line.entrypoint;
    if (line.cwd) this.root ??= line.cwd;
    if (subagentId !== undefined) return this.subagent(subagentId);
    // Older transcripts keep subagent lines in the main file, marked as sidechain.
    if (line.isSidechain) return this.subagent(line.agentId ?? 'sidechain');
    return this.main;
  }

  private onAssistant(raw: Record<string, unknown>, subagentId: string | undefined): boolean {
    const parsed = assistantLine.safeParse(raw);
    if (!parsed.success) return false;
    const line = parsed.data;
    const state = this.enter(line, subagentId);
    const { calls } = state.context;

    if (!state.callIndexById.has(line.message.id)) {
      calls.push({ index: calls.length + 1, messageId: line.message.id, timestamp: line.timestamp, model: line.message.model, usage: toUsage(line.message.usage) });
      state.callIndexById.set(line.message.id, calls.length);
    }

    const blocks = typeof line.message.content === 'string' ? [{ type: 'text', text: line.message.content }] : line.message.content;
    for (const block of blocks) {
      const text = textBlock.safeParse(block);
      if (text.success) {
        this.agentText.push(text.data.text);
        continue;
      }
      const tool = toolUseBlock.safeParse(block);
      if (tool.success) {
        const { id, name, input } = tool.data;
        state.pending.set(id, { name, input, cwd: line.wireIngestContext?.[id]?.cwd ?? line.cwd, timestamp: line.timestamp });
        // Writing a memory file is not using it: keep its path, not the text written into it.
        const target = typeof input.file_path === 'string' ? input.file_path : undefined;
        if (FILE_WRITERS.has(name) && target !== undefined && isMemoryFile(target)) this.agentText.push(target);
        else collectStrings(input, this.agentText);
      }
    }
    return true;
  }

  private onUser(raw: Record<string, unknown>, subagentId: string | undefined): boolean {
    const parsed = userLine.safeParse(raw);
    if (!parsed.success) return false;
    const line = parsed.data;
    const state = this.enter(line, subagentId);
    if (typeof line.message.content === 'string') return true;

    for (const block of line.message.content) {
      const result = toolResultBlock.safeParse(block);
      if (!result.success) continue;
      const pending = state.pending.get(result.data.tool_use_id);
      if (!pending) {
        this.stats.orphanResults++;
        continue;
      }
      state.pending.delete(result.data.tool_use_id);

      const root = this.root ?? '/';
      const effects = classifyToolCall(pending.name, pending.input, pending.cwd ?? root, root);
      const isError = result.data.is_error === true;
      const timestamp = line.timestamp ?? pending.timestamp;

      if (effects.reads.length > 0) {
        const text = resultText(result.data.content);
        const persisted = text.startsWith('<persisted-output>') || (isRecord(line.toolUseResult) && typeof line.toolUseResult.persistedOutputPath === 'string');
        const tokens = estimateTokens(text) / effects.reads.length;
        const resultHash = hash(text);
        for (const read of effects.reads) {
          state.context.reads.push({
            ...read, key: readKey(read), tokens, resultHash,
            turn: state.context.calls.length + 1, timestamp, toolUseId: result.data.tool_use_id, persisted, isError,
          });
        }
      }
      if (!isError) for (const change of effects.changes) this.changes.push({ ...change, timestamp });
    }
    return true;
  }

  private onAttachment(raw: Record<string, unknown>, subagentId: string | undefined): boolean {
    const parsed = attachmentLine.safeParse(raw);
    if (!parsed.success) return false;
    const line = parsed.data;
    const state = this.enter(line, subagentId);
    if (subagentId === undefined) this.recordsMemory = true;
    const turn = state.context.calls.length + 1;

    if (line.attachment.type === 'instructions') {
      const instructions = instructionsAttachment.safeParse(raw.attachment);
      if (!instructions.success) return false;
      for (const file of instructions.data.files) {
        state.context.memory.push({ ...file, tokens: estimateTokens(file.content), source: 'instructions', turn, timestamp: line.timestamp });
      }
    } else if (line.attachment.type === 'nested_memory') {
      const nested = nestedMemoryAttachment.safeParse(raw.attachment);
      if (!nested.success) return false;
      const file = nested.data.content;
      state.context.memory.push({ ...file, tokens: estimateTokens(file.content), source: 'nested', turn, timestamp: line.timestamp });
    }
    return true;
  }

  private onSystem(raw: Record<string, unknown>, subagentId: string | undefined): boolean {
    const parsed = systemLine.safeParse(raw);
    if (!parsed.success) return false;
    const state = this.enter(parsed.data, subagentId);
    if (parsed.data.subtype === 'compact_boundary') state.context.compactions.push(state.context.calls.length);
    return true;
  }

  private onCostState(raw: Record<string, unknown>): boolean {
    const parsed = costStateLine.safeParse(raw);
    if (!parsed.success) return false;
    const models = Object.values(parsed.data.modelUsage);
    this.costState = {
      input: models.reduce((sum, m) => sum + m.inputTokens, 0),
      cacheWrite: models.reduce((sum, m) => sum + m.cacheCreationInputTokens, 0),
      cacheRead: models.reduce((sum, m) => sum + m.cacheReadInputTokens, 0),
      output: models.reduce((sum, m) => sum + m.outputTokens, 0),
    };
    return true;
  }
}

function finishContext({ context }: ContextState): Context {
  const turns = context.calls.length;
  for (const item of [...context.reads, ...context.memory]) {
    if (item.turn !== undefined && item.turn > turns) item.turn = undefined;
  }
  const writes = sumUsage(context.calls.map((call) => call.usage));
  context.cacheTtl = (writes.cacheWrite1h ?? 0) > (writes.cacheWrite5m ?? 0) ? '1h' : '5m';
  return context;
}

export interface ParseOptions {
  /** Absolute folder that paths are made relative to. Defaults to the cwd of each session's first line. */
  root?: string;
}

/** Parses one session and its subagents. Broken or unknown lines are counted in `stats` and skipped. */
export async function parseSession(files: SessionFiles, options: ParseOptions = {}): Promise<ParsedSession> {
  const parser = new SessionParser(options.root);
  await parser.readFile(files.file);

  for (const subagent of files.subagents) {
    await parser.readFile(subagent.file, subagent.agentId);
    const state = parser.subagent(subagent.agentId);
    if (subagent.metaFile !== undefined) {
      try {
        const meta = subagentMeta.safeParse(JSON.parse(readFileSync(subagent.metaFile, 'utf8')));
        if (meta.success) {
          state.context.agentType = meta.data.agentType;
          state.context.parentToolUseId = meta.data.toolUseId;
        }
      } catch {
        // A broken meta file only loses the subagent's type.
      }
    }
  }

  const main = finishContext(parser.main);
  const subagents = [...parser.subagents.values()].map(finishContext);

  let unrecordedUsage: Usage | undefined;
  if (parser.costState) {
    const recorded = sumUsage([main, ...subagents].flatMap((context) => context.calls.map((call) => call.usage)));
    const missing = (total: number, seen: number): number => Math.max(0, total - seen);
    unrecordedUsage = {
      input: missing(parser.costState.input, recorded.input),
      cacheWrite: missing(parser.costState.cacheWrite, recorded.cacheWrite),
      cacheRead: missing(parser.costState.cacheRead, recorded.cacheRead),
      output: missing(parser.costState.output, recorded.output),
    };
  }

  return {
    sessionId: files.sessionId,
    file: files.file,
    root: parser.root ?? '/',
    startedAt: parser.startedAt,
    endedAt: parser.endedAt,
    versions: [...parser.versions].sort(),
    entrypoint: parser.entrypoint,
    main,
    subagents,
    fileChanges: parser.changes,
    agentText: parser.agentText,
    costState: parser.costState,
    unrecordedUsage,
    recordsMemory: parser.recordsMemory,
    stats: parser.stats,
  };
}

/** Parses every session in a transcript folder, oldest first. */
export async function parseProject(dir: string, options: ParseOptions = {}): Promise<ParsedProject> {
  const sessions: ParsedSession[] = [];
  for (const files of await listSessionFiles(dir)) sessions.push(await parseSession(files, options));
  sessions.sort((a, b) => (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿'));

  const seen = new Set<string>();
  let duplicateCalls = 0;
  for (const session of sessions) {
    const ids = new Set([session.main, ...session.subagents].flatMap((context) => context.calls.map((call) => call.messageId)));
    for (const id of ids) {
      if (seen.has(id)) duplicateCalls++;
      seen.add(id);
    }
  }

  return { dir, sessions, stats: mergeLineStats(sessions.map((session) => session.stats)), duplicateCalls };
}
