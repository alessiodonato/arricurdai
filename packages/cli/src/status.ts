import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_COST_PARAMS, type Usage, weightedCost } from '@arricurdai/core';
import { claudeConfigDir, GUARD_STOP } from '@arricurdai/transcripts';
import { CACHE_READ_SHARE, DEFAULT_MIN_TOKENS, duration, INPUT_PRICE, lastCall, readTail } from './guard';
import { MENU_ICON } from './menu-icon';
import { type CommandIO, UserError, withErrors } from './run-profile';

// `arricurdai status`: the sessions of every project that ran in the last hours, how large their context is
// and when their prompt cache expires, with what today cost. It reads the end of each transcript only, so it
// can run every minute, as a menu bar plugin does. Local files only, and never the text of a session.

export interface StatusCommandOptions {
  hours?: string;
  limit?: string;
  minTokens?: string;
  json?: boolean;
  swiftbar?: boolean;
}

export interface StatusIO extends CommandIO {
  /** The node program and the arricurdai script, for the menu items that run a command. */
  node: string;
  bin: string;
}

export interface SessionStatus {
  sessionId: string;
  /** The folder the session ran in, when its transcript says. */
  project: string | undefined;
  model: string | undefined;
  /** Tokens of the last request: what the next prompt sends again. */
  context: number;
  lastCallAt: string;
  cacheExpiresAt: string;
  cacheLive: boolean;
  /** The cache expired and the context is large enough: the guard stops the next prompt. */
  guardWillStop: boolean;
}

export interface TodayStatus {
  since: string;
  calls: number;
  tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** At API prices, for the calls of models with a known price. */
  usd: number;
  /** Calls of models with no known price, left out of `usd`. */
  unpricedCalls: number;
  guardStops: number;
}

export interface Status {
  generatedAt: string;
  hours: number;
  minTokens: number;
  sessions: SessionStatus[];
  today: TodayStatus;
}

interface TranscriptFile {
  path: string;
  mtimeMs: number;
  /** The transcript of a session, not of one of its subagents. */
  main: boolean;
}

const FIRST_CHUNK = 4 * 1024 * 1024;

function mtime(path: string): number | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The transcripts written since a time, of every project: sessions and their subagents. */
export function recentTranscripts(claudeDir: string, since: number): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  const projects = join(claudeDir, 'projects');
  for (const project of list(projects)) {
    const dir = join(projects, project);
    for (const entry of list(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const path = join(dir, entry);
      const time = mtime(path);
      if (time === undefined || time < since) continue;
      const main = !entry.startsWith('agent-');
      files.push({ path, mtimeMs: time, main });
      if (!main) continue;
      // A subagent writes only while its session runs, so an older session has no newer subagents.
      const subagents = join(dir, entry.slice(0, -'.jsonl'.length), 'subagents');
      for (const name of list(subagents)) {
        if (!name.endsWith('.jsonl')) continue;
        const sub = join(subagents, name);
        const subTime = mtime(sub);
        if (subTime !== undefined && subTime >= since) files.push({ path: sub, mtimeMs: subTime, main: false });
      }
    }
  }
  return files;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The folder of the last line of a transcript that records one. */
export function lastCwd(text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line?.includes('"cwd"')) continue;
    const cwd = parse(line)?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  return undefined;
}

const HEAD_BYTES = 256 * 1024;

/** The folder a session started in, from the first lines of its transcript: the project, even after a cd. */
export function firstCwd(path: string): string | undefined {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, fstatSync(fd).size));
    readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      const cwd = parse(line)?.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The status of one session, from the end of its transcript and the folder it started in. */
export function sessionStatus(sessionId: string, tail: string, now: number, minTokens: number, project?: string): SessionStatus | undefined {
  const call = lastCall(tail);
  if (!call || !Number.isFinite(call.at)) return undefined;
  const expires = call.at + call.ttlMs;
  const cacheLive = now <= expires;
  return {
    sessionId,
    project: project ?? lastCwd(tail),
    model: call.model,
    context: call.context,
    lastCallAt: new Date(call.at).toISOString(),
    cacheExpiresAt: new Date(expires).toISOString(),
    cacheLive,
    guardWillStop: !cacheLive && call.context >= minTokens,
  };
}

/**
 * The end of a file that holds every line written since a time. Transcripts only grow at the end, so it
 * reads a larger end until the first whole line it holds is older than that time, or the whole file.
 */
export function readSince(path: string, since: number, firstChunk = FIRST_CHUNK): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let bytes = Math.min(size, firstChunk); ; bytes = Math.min(size, bytes * 4)) {
      const buffer = Buffer.alloc(bytes);
      readSync(fd, buffer, 0, bytes, size - bytes);
      const text = buffer.toString('utf8');
      if (bytes >= size) return text;
      // The first line is cut: it starts before the part read.
      const whole = text.slice(text.indexOf('\n') + 1);
      const first = /"timestamp":"([^"]+)"/.exec(whole)?.[1];
      if (first !== undefined && Date.parse(first) < since) return whole;
    }
  } finally {
    closeSync(fd);
  }
}

interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Adds the calls and the stops of the guard that a part of a transcript holds since a time. */
export function addToday(today: TodayStatus, text: string, since: number, main: boolean, seen: Set<string>): void {
  for (const line of text.split('\n')) {
    const isCall = line.includes('"usage"');
    const isStop = main && line.includes(GUARD_STOP);
    if (!isCall && !isStop) continue;
    const entry = parse(line);
    if (!entry || !(Date.parse(String(entry.timestamp)) >= since)) continue;
    if (isStop && entry.type === 'system' && entry.subtype === 'informational' && String(entry.content).includes(GUARD_STOP)) {
      today.guardStops++;
      continue;
    }
    const message = entry.message as { id?: unknown; model?: unknown; usage?: UsageFields } | undefined;
    const usage = message?.usage;
    if (entry.type !== 'assistant' || !usage || message?.model === '<synthetic>') continue;
    // Claude Code writes one line for each part of a reply, all with the usage of the same call.
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const tokens: Usage = {
      input: count(usage.input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      cacheWrite5m: count(usage.cache_creation?.ephemeral_5m_input_tokens),
      cacheWrite1h: count(usage.cache_creation?.ephemeral_1h_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      output: count(usage.output_tokens),
    };
    if (tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output === 0) continue;
    today.calls++;
    today.tokens.input += tokens.input;
    today.tokens.cacheWrite += tokens.cacheWrite;
    today.tokens.cacheRead += tokens.cacheRead;
    today.tokens.output += tokens.output;
    const model = typeof message.model === 'string' ? message.model : '';
    const price = INPUT_PRICE[model];
    if (price === undefined) today.unpricedCalls++;
    else today.usd += (weightedCost(tokens, { ...DEFAULT_COST_PARAMS, r: CACHE_READ_SHARE[model] ?? DEFAULT_COST_PARAMS.r }) * price) / 1e6;
  }
}

function whole(value: string | undefined, fallback: number, option: string, min: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) throw new UserError(`${option} must be a whole number of ${min} or more, got "${value}"`);
  return number;
}

/** Reads the status of the sessions of the last hours and what today cost. */
export function readStatus(options: StatusCommandOptions, io: Pick<CommandIO, 'env' | 'now'>): Status {
  const hours = whole(options.hours, 24, '--hours', 1);
  const limit = whole(options.limit, 10, '--limit', 1);
  const minTokens = whole(options.minTokens, DEFAULT_MIN_TOKENS, '--min-tokens', 0);
  const now = io.now();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const from = Math.min(midnight, now.getTime() - hours * 3_600_000);
  const files = recentTranscripts(claudeConfigDir(io.env), from);

  const sessions: SessionStatus[] = [];
  for (const file of files) {
    if (!file.main || file.mtimeMs < now.getTime() - hours * 3_600_000) continue;
    try {
      const status = sessionStatus(basename(file.path, '.jsonl'), readTail(file.path), now.getTime(), minTokens, firstCwd(file.path));
      if (status) sessions.push(status);
    } catch {
      // A transcript that cannot be read says nothing: the others still do.
    }
  }
  sessions.sort((a, b) => Date.parse(b.lastCallAt) - Date.parse(a.lastCallAt));

  const today: TodayStatus = {
    since: new Date(midnight).toISOString(),
    calls: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    usd: 0,
    unpricedCalls: 0,
    guardStops: 0,
  };
  const seen = new Set<string>();
  for (const file of files) {
    if (file.mtimeMs < midnight) continue;
    try {
      addToday(today, readSince(file.path, midnight), midnight, file.main, seen);
    } catch {
      // As above.
    }
  }
  return { generatedAt: now.toISOString(), hours, minTokens, sessions: sessions.slice(0, limit), today };
}

/** 312,000 as 312k, 2,140,000 as 2.1M. */
export function short(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`;
  return String(tokens);
}

const projectName = (session: SessionStatus): string => (session.project ? basename(session.project) : session.sessionId.slice(0, 8));

/** In the last minutes of a large cache the menu bar turns orange: there is still time to go on. */
const SOON = 10 * 60_000;

function cacheState(session: SessionStatus, now: number, brief = false): string {
  const left = Date.parse(session.cacheExpiresAt) - now;
  if (session.cacheLive) return `cache expires in ${duration(Math.max(0, left))}`;
  const ago = `cache expired ${duration(-left)} ago`;
  if (!session.guardWillStop) return ago;
  return brief ? `${ago} · guard` : `${ago}: the guard stops the next prompt`;
}

function todayLine(today: TodayStatus): string {
  const calls = `${today.calls.toLocaleString('en-US')} call${today.calls === 1 ? '' : 's'}`;
  const usd = today.calls > today.unpricedCalls ? `about $${today.usd.toFixed(2)} at API prices over ${calls}` : calls;
  const unpriced = today.unpricedCalls > 0 && today.calls > today.unpricedCalls ? ` (${today.unpricedCalls} of models with no known price left out)` : '';
  return `Today: ${usd}${unpriced}`;
}

const stops = (n: number): string => `${n} stop${n === 1 ? '' : 's'} of the guard`;

export function renderStatus(status: Status): string {
  const now = Date.parse(status.generatedAt);
  const lines: string[] = [];
  if (status.sessions.length === 0) {
    lines.push(`No Claude Code session in the last ${status.hours} hours.`);
  } else {
    lines.push(`Claude Code sessions of the last ${status.hours} hours`, '');
    const names = status.sessions.map(projectName);
    const width = Math.max(...names.map((name) => name.length));
    const sizes = status.sessions.map((session) => session.context.toLocaleString('en-US'));
    const sizeWidth = Math.max(...sizes.map((size) => size.length));
    status.sessions.forEach((session, index) => {
      lines.push(`  ${names[index]!.padEnd(width)}   ${sizes[index]!.padStart(sizeWidth)} tokens   ${cacheState(session, now)}`);
    });
  }
  lines.push('', `${todayLine(status.today)}, ${stops(status.today.guardStops)}.`);
  return `${lines.join('\n')}\n`;
}

/** SwiftBar and xbar split a line at `|` and read `--` at its start as a submenu. */
const menuText = (text: string): string => text.replace(/[|\n\r]/g, ' ').replace(/^-+/, '');
const quoted = (value: string): string | undefined => (/["|\n\r]/.test(value) ? undefined : `"${value}"`);

/** The session the menu bar counts down to: the large one whose live cache expires first. */
export function focusSession(status: Status): SessionStatus | undefined {
  return status.sessions
    .filter((session) => session.cacheLive && session.context >= status.minTokens)
    .sort((a, b) => Date.parse(a.cacheExpiresAt) - Date.parse(b.cacheExpiresAt))[0];
}

/** The status as the output of a SwiftBar or xbar plugin: a title, then the menu. */
export function renderSwiftBar(status: Status, io: Pick<StatusIO, 'node' | 'bin'>): string {
  const now = Date.parse(status.generatedAt);
  const focus = focusSession(status);
  const icon = `templateImage=${MENU_ICON}`;
  let title = ` | ${icon}`;
  if (focus) {
    const left = Date.parse(focus.cacheExpiresAt) - now;
    const soon = left <= SOON ? ' color=#d97706' : '';
    title = `${short(focus.context)} · ${duration(Math.max(0, left))} | ${icon}${soon}`;
  }
  const lines = [title, '---'];
  if (status.sessions.length === 0) {
    lines.push(`No Claude Code session in the last ${status.hours} hours | color=gray`);
  } else {
    lines.push(`Claude Code sessions of the last ${status.hours} hours | size=12 color=gray`);
    const node = quoted(io.node);
    const bin = quoted(io.bin);
    for (const session of status.sessions) {
      // Orange only where there is something to do: a large cache about to expire. An expired one is history.
      const left = Date.parse(session.cacheExpiresAt) - now;
      const style = !session.cacheLive ? ' | color=gray' : session.context >= status.minTokens && left <= SOON ? ' | color=#d97706' : '';
      lines.push(menuText(`${projectName(session)} · ${short(session.context)} · ${cacheState(session, now, true)}`) + style);
      const project = session.project === undefined ? undefined : quoted(session.project);
      if (node && bin && project) {
        lines.push(`--Profile this project in Terminal | bash=${node} param1=${bin} param2=profile param3=--project param4=${project} terminal=true`);
      }
    }
  }
  lines.push('---', menuText(todayLine(status.today)), `Guard stops today: ${status.today.guardStops}`);
  lines.push('---', 'Refresh | refresh=true');
  return `${lines.join('\n')}\n`;
}

/** Runs `arricurdai status` and returns the exit code. Never throws. */
export function runStatus(options: StatusCommandOptions, io: StatusIO): Promise<number> {
  return withErrors(io, async () => {
    if (options.json && options.swiftbar) throw new UserError('choose one of --json and --swiftbar');
    const status = readStatus(options, io);
    if (options.json) io.stdout(`${JSON.stringify(status, null, 2)}\n`);
    else if (options.swiftbar) io.stdout(renderSwiftBar(status, io));
    else io.stdout(renderStatus(status));
  });
}
