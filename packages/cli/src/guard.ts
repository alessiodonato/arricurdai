import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { claudeConfigDir } from '@arricurdai/transcripts';
import { typedPrompt } from './prompts';
import { formatHits, hideSecrets, knownSecrets, loadChunks, redact, search } from './recall';

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

/** One folder for each user: on Linux the temporary folder is shared, and a folder made by one user would shut out the others. */
export const DEFAULT_STATE_DIR = join(tmpdir(), typeof process.getuid === 'function' ? `arricurdai-${process.getuid()}` : 'arricurdai');
export const DEFAULT_MIN_TOKENS = 100_000;

const HOUR = 3_600_000;
const TAIL_BYTES = 2 * 1024 * 1024;
const MARKER_MAX_AGE = 12 * HOUR;
/** The share of the stopped prompt that a passage must hold to enter the note: below it, a passage is mostly noise. */
const NOTE_MIN_COVERAGE = 0.4;
/**
 * Input price in USD per million tokens, measured from the costs Claude Code records. Claude Fable 5.2 has no
 * recorded cost yet: its price is the published one.
 */
export const INPUT_PRICE: Record<string, number> = {
  'claude-fable-5-2': 8,
  'claude-opus-5-5': 4,
  'claude-opus-5': 5,
  'claude-sonnet-5-5': 2,
  'claude-haiku-5-5': 0.1,
  'claude-haiku-4-5-20251001': 1,
};
/** The price of a cache read as a share of the input price, for the models where it is not 0.05. */
export const CACHE_READ_SHARE: Record<string, number> = {
  'claude-fable-5-2': 0.025,
  'claude-opus-5': 0.1,
  'claude-haiku-5-5': 0.1,
  'claude-haiku-4-5-20251001': 0.1,
};
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

export function duration(ms: number): string {
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

export function readTail(path: string): string {
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

/**
 * Whether the state folder is a folder of this user that no one else can read or write. The files in it hold
 * a prompt, and name the transcript the note is read from: in a folder that someone else can write, neither can be trusted.
 */
export function isPrivateDir(dir: string): boolean {
  try {
    const stats = lstatSync(dir);
    if (!stats.isDirectory()) return false;
    // Windows has no such owners and modes: there the temporary folder is already of one user.
    if (typeof process.getuid !== 'function') return true;
    return stats.uid === process.getuid() && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Makes the state folder, for this user only. Returns false when it is there and is not private. */
function openStateDir(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  // A folder of this user that an earlier version left open is closed to the others.
  if (stats.isDirectory() && typeof process.getuid === 'function' && stats.uid === process.getuid() && (stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return isPrivateDir(dir);
}

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
    // Without a folder to remember the stop in, it could not tell a prompt sent again: the prompt goes through.
    if (!openStateDir(io.stateDir)) return 0;
    const seen = join(io.stateDir, `guard-${safe(input.session_id)}`);
    const marker = markerPath(io.stateDir, input.transcript_path);
    if (existsSync(seen) && readFileSync(seen, 'utf8') === String(call.at)) {
      // Sent again: the user chose to go on here.
      rmSync(marker, { force: true });
      return 0;
    }
    writeFileSync(seen, String(call.at), { mode: 0o600 });
    writeFileSync(marker, JSON.stringify({ transcript: input.transcript_path, context: call.context, at: io.now().getTime(), prompt: input.prompt }), { mode: 0o600 });
    io.stdout(JSON.stringify({ decision: 'block', reason: message }));
    return 0;
  } catch {
    return 0;
  }
}

const shorten = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

const under = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Folders whose files a new session rarely needs by name: temporary ones, and the one Claude Code keeps for itself, with its memory. */
const sideRoots = (): string[] => [tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/var/folders', '/private/var/folders', claudeConfigDir(process.env)];

/** The folder that holds all of these files. */
function commonFolder(paths: readonly string[]): string {
  let common = dirname(paths[0] ?? '').split(sep);
  for (const path of paths.slice(1)) {
    const parts = dirname(path).split(sep);
    let same = 0;
    while (same < common.length && common[same] === parts[same]) same++;
    common = common.slice(0, same);
  }
  return common.join(sep) || sep;
}

/** A note on a session, from its transcript: the last requests, the files changed, open tasks, the last reply. */
export function handoffNote(text: string, cwd: string | undefined, context: number): string | undefined {
  const prompts: { text: string; pasted: boolean }[] = [];
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
      // Leaves out tool results, command wrappers such as <command-name> and notices such as [Request interrupted].
      const prompt = typedPrompt(content);
      if (prompt) prompts.push(prompt);
    } else if (entry.type === 'assistant') {
      for (const block of blocks(content)) {
        if (block.type === 'text' && block.text?.trim()) reply = block.text.trim();
        if (block.type !== 'tool_use') continue;
        const path = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof path === 'string' && EDIT_TOOLS.has(block.name ?? '')) {
          // Set again, so that the files stay in the order of their last edit.
          const edits = (files.get(path) ?? 0) + 1;
          files.delete(path);
          files.set(path, edits);
        }
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) todos = block.input.todos as typeof todos;
      }
    }
  }
  if (prompts.length === 0 && files.size === 0 && reply === undefined) return undefined;

  const outside = (path: string): boolean => cwd === undefined || relative(cwd, path).startsWith('..');
  const where = (path: string): string => (outside(path) ? path : relative(cwd!, path));
  // Files outside the project in a temporary folder, or in the folder of Claude Code: counted for each folder, not listed.
  const roots = sideRoots();
  const aside = new Map<string, string[]>();
  const listed: [string, number][] = [];
  for (const [path, edits] of files) {
    const root = outside(path) ? roots.find((candidate) => under(path, candidate)) : undefined;
    if (root === undefined) listed.push([path, edits]);
    else aside.set(root, [...(aside.get(root) ?? []), path]);
  }
  const changed = listed.slice(-30).map(([path, edits]) => (edits > 1 ? `${where(path)} (${edits} edits)` : where(path)));
  const counted = [...aside.values()].map((paths) => `${paths.length} under ${commonFolder(paths)}`);
  const open = todos.filter((todo) => todo.status !== 'completed' && typeof todo.content === 'string');
  const parts = [
    `Note from arricurdai on the previous session, last active ${lastActive ?? 'at an unknown time'}. It was cleared after a pause so as not to write its ${context.toLocaleString('en-US')} tokens of context to the cache again. Read files again when you need their content.`,
  ];
  if (prompts.length > 0) parts.push(`Last requests of the user:\n${prompts.slice(-3).map((prompt, index) => `${index + 1}. ${prompt.pasted ? '(with pasted text) ' : ''}${shorten(redact(prompt.text), 500)}`).join('\n')}`);
  if (changed.length > 0) parts.push(`Files changed: ${changed.join(', ')}`);
  if (counted.length > 0) parts.push(`Temporary files and files of Claude Code changed, not listed: ${counted.join(', ')}`);
  if (open.length > 0) parts.push(`Open tasks:\n${open.map((todo) => `- [${String(todo.status)}] ${shorten(redact(String(todo.content)), 200)}`).join('\n')}`);
  if (reply !== undefined) parts.push(`Last reply of the assistant:\n${shorten(redact(reply), 2000)}`);
  return parts.join('\n\n');
}

/** The note on the session the guard stopped, and the earlier context that matches the prompt it stopped. */
function afterClear(input: HookInput & { transcript_path: string }, io: HookIO): string[] {
  const marker = markerPath(io.stateDir, input.transcript_path);
  if (!isPrivateDir(io.stateDir) || !existsSync(marker)) return [];
  const pending = parse<{ transcript?: string; context?: number; at?: number; prompt?: string }>(readFileSync(marker, 'utf8'));
  rmSync(marker, { force: true });
  if (!pending?.transcript || pending.transcript === input.transcript_path) return [];
  if (!(io.now().getTime() - (pending.at ?? 0) < MARKER_MAX_AGE)) return [];
  const note = handoffNote(readFileSync(pending.transcript, 'utf8'), input.cwd, pending.context ?? 0);
  if (!note) return [];
  const { chunks, sessions } = loadChunks(dirname(input.transcript_path), input.session_id);
  const parts = [hideSecrets(note, knownSecrets(chunks))];
  const prompt = pending.prompt?.trim();
  if (prompt) {
    const hits = search(chunks, prompt, 3, NOTE_MIN_COVERAGE);
    if (hits.length > 0) parts.push(`Earlier context that matches the prompt you were about to send:\n${formatHits(hits, shorten(redact(prompt), 80), sessions, 800)}`);
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
