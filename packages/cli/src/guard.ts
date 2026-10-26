import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { formatHits, loadChunks, search } from './recall';

// Two Claude Code hooks. `guard` (UserPromptSubmit) stops the first prompt after a pause that let the
// prompt cache of a large session expire: going on would write the whole context to the cache again.
// `handoff` (SessionStart) gives the session started with /clear a note on the one the guard stopped, with
// the earlier context that matches the stopped prompt, and tells every new session how to run recall.
// Both fail open: on any problem they print nothing and the prompt goes through.

/** The last API call of a session, read from the end of its transcript. */
export interface LastCall {
  at: number;
  model: string | undefined;
  /** Tokens of the request: input, cache writes and cache reads. */
  context: number;
  /** How long the cache keeps the context: one hour for main sessions, five minutes otherwise. */
  ttlMs: number;
}

export interface HookIO {
  stdout: (text: string) => void;
  now: () => Date;
  /** Folder for the small files that link a stopped prompt to the next /clear. */
  stateDir: string;
  /** The command an agent runs to search earlier sessions, for the hint every new session gets. */
  recallCommand?: string;
}

export const DEFAULT_STATE_DIR = join(tmpdir(), 'arricurdai');
export const DEFAULT_MIN_TOKENS = 100_000;

const HOUR = 3_600_000;
const TAIL_BYTES = 2 * 1024 * 1024;
const MARKER_MAX_AGE = 12 * HOUR;
/** Input price in USD per million tokens, measured from the costs Claude Code records. */
const INPUT_PRICE: Record<string, number> = { 'claude-opus-5-5': 4, 'claude-sonnet-5-5': 2 };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface Entry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: {
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
  };
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  prompt?: string;
}

function parse<T>(line: string): T | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

/** Finds the last API call in the end of a transcript, and the cache lifetime of its latest writes. */
export function lastCall(text: string): LastCall | undefined {
  const lines = text.split('\n');
  let last: Omit<LastCall, 'ttlMs'> | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line?.includes('"usage"')) continue;
    const entry = parse<Entry>(line);
    const usage = entry?.message?.usage;
    if (entry?.type !== 'assistant' || entry.isSidechain || !usage || entry.message?.model === '<synthetic>') continue;
    const context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    if (context === 0) continue;
    last ??= { at: Date.parse(entry.timestamp ?? ''), model: entry.message?.model, context };
    const written = usage.cache_creation;
    if (written?.ephemeral_1h_input_tokens) return { ...last, ttlMs: HOUR };
    if (written?.ephemeral_5m_input_tokens) return { ...last, ttlMs: 5 * 60_000 };
  }
  return last && { ...last, ttlMs: HOUR };
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The message that stops the prompt, or undefined when the cache still lives or the context is small. */
export function guardMessage(call: LastCall, now: number, minTokens: number): string | undefined {
  const idle = now - call.at;
  if (!(idle > call.ttlMs) || call.context < minTokens) return undefined;
  const price = call.model === undefined ? undefined : INPUT_PRICE[call.model];
  const write = call.ttlMs === HOUR ? 2 : 1.25;
  const usd = price === undefined ? '' : `, about $${((call.context * write * price) / 1e6).toFixed(2)}`;
  return [
    `arricurdai: this session was idle for ${duration(idle)} and its prompt cache expired.`,
    `Your prompt would write its ${call.context.toLocaleString('en-US')} tokens of context to the cache again${usd}, and every later call would read them.`,
    'Run /clear to start a new session: arricurdai will give it a note on this one. Or send the prompt again to go on here.',
  ].join('\n');
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9-]/g, '_');
/** One pending note per transcript folder, that is per project. */
const markerPath = (stateDir: string, transcript: string): string => join(stateDir, `handoff-${safe(dirname(transcript))}.json`);

/** UserPromptSubmit hook. Prints a block decision, or nothing to let the prompt through. */
export function runGuard(stdin: string, options: { minTokens?: string }, io: HookIO): number {
  try {
    const input = parse<HookInput>(stdin);
    if (!input?.session_id || !input.transcript_path) return 0;
    const call = lastCall(readTail(input.transcript_path));
    const minTokens = Number(options.minTokens ?? DEFAULT_MIN_TOKENS);
    const message = call && guardMessage(call, io.now().getTime(), Number.isFinite(minTokens) ? minTokens : DEFAULT_MIN_TOKENS);
    if (!call || !message) return 0;
    mkdirSync(io.stateDir, { recursive: true });
    const seen = join(io.stateDir, `guard-${safe(input.session_id)}`);
    const marker = markerPath(io.stateDir, input.transcript_path);
    if (existsSync(seen) && readFileSync(seen, 'utf8') === String(call.at)) {
      // Sent again: the user chose to go on here.
      rmSync(marker, { force: true });
      return 0;
    }
    writeFileSync(seen, String(call.at));
    writeFileSync(marker, JSON.stringify({ transcript: input.transcript_path, context: call.context, at: io.now().getTime(), prompt: input.prompt }));
    io.stdout(JSON.stringify({ decision: 'block', reason: message }));
    return 0;
  } catch {
    return 0;
  }
}

const shorten = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** A note on a session, from its transcript: the last requests, the files changed, open tasks, the last reply. */
export function handoffNote(text: string, cwd: string | undefined, context: number): string | undefined {
  const prompts: string[] = [];
  const files = new Map<string, number>();
  let todos: { content?: unknown; status?: unknown }[] = [];
  let reply: string | undefined;
  let lastActive: string | undefined;
  for (const line of text.split('\n')) {
    const entry = parse<Entry>(line);
    if (!entry || entry.isSidechain) continue;
    lastActive = entry.timestamp ?? lastActive;
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta && !entry.isCompactSummary) {
      const typed = typeof content === 'string' ? content : blocks(content).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
      // Leaves out tool results, command wrappers such as <command-name> and notices such as [Request interrupted].
      if (typed.trim() && !/^\s*[<[]/.test(typed)) prompts.push(typed.trim());
    } else if (entry.type === 'assistant') {
      for (const block of blocks(content)) {
        if (block.type === 'text' && block.text?.trim()) reply = block.text.trim();
        if (block.type !== 'tool_use') continue;
        const path = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof path === 'string' && EDIT_TOOLS.has(block.name ?? '')) files.set(path, (files.get(path) ?? 0) + 1);
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) todos = block.input.todos as typeof todos;
      }
    }
  }
  if (prompts.length === 0 && files.size === 0 && reply === undefined) return undefined;

  const where = (path: string): string => {
    const inside = cwd === undefined ? path : relative(cwd, path);
    return inside.startsWith('..') ? path : inside;
  };
  const open = todos.filter((todo) => todo.status !== 'completed' && typeof todo.content === 'string');
  const parts = [
    `Note from arricurdai on the previous session, last active ${lastActive ?? 'at an unknown time'}. It was cleared after a pause so as not to write its ${context.toLocaleString('en-US')} tokens of context to the cache again. Read files again when you need their content.`,
  ];
  if (prompts.length > 0) parts.push(`Last requests of the user:\n${prompts.slice(-3).map((prompt, index) => `${index + 1}. ${shorten(prompt, 500)}`).join('\n')}`);
  if (files.size > 0) parts.push(`Files changed: ${[...files].slice(-30).map(([path, edits]) => (edits > 1 ? `${where(path)} (${edits} edits)` : where(path))).join(', ')}`);
  if (open.length > 0) parts.push(`Open tasks:\n${open.map((todo) => `- [${String(todo.status)}] ${shorten(String(todo.content), 200)}`).join('\n')}`);
  if (reply !== undefined) parts.push(`Last reply of the assistant:\n${shorten(reply, 2000)}`);
  return parts.join('\n\n');
}

/** The note on the session the guard stopped, and the earlier context that matches the prompt it stopped. */
function afterClear(input: HookInput & { transcript_path: string }, io: HookIO): string[] {
  const marker = markerPath(io.stateDir, input.transcript_path);
  if (!existsSync(marker)) return [];
  const pending = parse<{ transcript?: string; context?: number; at?: number; prompt?: string }>(readFileSync(marker, 'utf8'));
  rmSync(marker, { force: true });
  if (!pending?.transcript || pending.transcript === input.transcript_path) return [];
  if (!(io.now().getTime() - (pending.at ?? 0) < MARKER_MAX_AGE)) return [];
  const note = handoffNote(readFileSync(pending.transcript, 'utf8'), input.cwd, pending.context ?? 0);
  if (!note) return [];
  const parts = [note];
  const prompt = pending.prompt?.trim();
  if (prompt) {
    const { chunks, sessions } = loadChunks(dirname(input.transcript_path), input.session_id);
    const hits = search(chunks, prompt, 3);
    if (hits.length > 0) parts.push(`Earlier context that matches the prompt you were about to send:\n${formatHits(hits, shorten(prompt, 80), sessions, 800)}`);
  }
  return parts;
}

/**
 * SessionStart hook. After a /clear that follows a stopped prompt, prints the note as additional context.
 * On every start it also tells the agent how to search earlier sessions.
 */
export function runHandoff(stdin: string, io: HookIO): number {
  try {
    const input = parse<HookInput>(stdin);
    if (!input?.transcript_path) return 0;
    const parts = input.source === 'clear' ? afterClear({ ...input, transcript_path: input.transcript_path }, io) : [];
    if (io.recallCommand) {
      const why = input.source === 'compact' ? 'The summary of this session leaves out details. ' : '';
      parts.push(`${why}To look up what was asked, decided or changed in earlier sessions of this project, run: ${io.recallCommand} "<words>"`);
    }
    if (parts.length > 0) io.stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } }));
    return 0;
  } catch {
    return 0;
  }
}
