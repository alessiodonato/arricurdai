import type { CostParams } from './config';
import { memoryRent, rent } from './cost';
import { turnsInContext } from './rediscovery';
import type { ProfileSession, SessionContext } from './session';

export interface MemoryLine {
  file: string;
  /** Line number in the file as loaded, from 1. */
  line: number;
  text: string;
  terms: string[];
  /** `import`: only an `@path` import, measured as its own file. `unverifiable`: no term to look for. */
  kind: 'verifiable' | 'unverifiable' | 'import';
}

// A file name: a letter somewhere in the name, and an extension of 2 to 8 characters that starts with a letter.
// It rules out "e.g", "v2.0" and "3.14".
const FILE_NAME = /^[\w.-]*[A-Za-z_][\w.-]*\.[A-Za-z][A-Za-z0-9]{1,7}$/;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const IMPORT = /(^|\s)@[~\w./-]+/;

const trimPunctuation = (token: string): string => token.replace(/^[("'[<{]+/, '').replace(/[)"'\]>}.,;:!?]+$/, '');

/**
 * Whether a token names a path or a file. Inside a code span any path counts. In prose a path needs
 * an extension, a leading `./`, `../`, `~/` or `/`, or a trailing `/`, so that "and/or" is not a path.
 */
function isPathLike(token: string, inCode: boolean): boolean {
  if (token.length === 0 || URL.test(token) || token.startsWith('@')) return false;
  if (!token.includes('/')) return FILE_NAME.test(token);
  if (inCode) return /[A-Za-z0-9]/.test(token);
  const last = token.replace(/\/+$/, '').split('/').pop() ?? '';
  return /^(\.{1,2}\/|~\/|\/)/.test(token) || token.endsWith('/') || FILE_NAME.test(last);
}

/**
 * Terms of a memory line that can be checked against what the agent did: code spans, paths,
 * file names and link targets. A function written as `name()` also yields `name`, and a path also
 * yields its file name.
 */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  const add = (term: string): void => {
    const trimmed = term.trim();
    if (trimmed.length >= 3) terms.add(trimmed);
  };
  const addPath = (path: string): void => {
    add(path);
    const name = path.replace(/\/+$/, '').split('/').pop() ?? '';
    if (name !== path && FILE_NAME.test(name)) add(name);
  };

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const span = match[1]!.trim();
    add(span);
    if (/^[\w$.]+\(\)$/.test(span)) add(span.slice(0, -2));
    for (const token of span.split(/\s+/)) {
      const word = trimPunctuation(token);
      if (isPathLike(word, true)) addPath(word);
    }
  }

  const prose = text.replace(/`[^`]*`/g, ' ');
  for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!URL.test(match[1]!)) addPath(match[1]!);
  }
  for (const token of prose.replace(/\]\([^)]*\)/g, ' ').split(/\s+/)) {
    const word = trimPunctuation(token);
    if (isPathLike(word, false)) addPath(word);
  }
  return [...terms];
}

/** Splits a memory file into the lines worth checking. Headings, blank lines and rules are left out. */
export function memoryLines(file: string, content: string): MemoryLine[] {
  const lines: MemoryLine[] = [];
  let inFence = false;
  content.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (trimmed === '') return;
    if (inFence) {
      // A line in a code block is a command or code: the whole line is the term.
      lines.push({ file, line: index + 1, text: trimmed, terms: [trimmed, ...extractTerms(`\`${trimmed}\``)].filter((t, i, all) => all.indexOf(t) === i), kind: 'verifiable' });
      return;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^([-*_]\s*){3,}$/.test(trimmed) || /^\|?[\s:|-]+\|?$/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) return;
    // Claude Code appends this warning when it cuts MEMORY.md at 200 lines.
    if (/^> WARNING: MEMORY\.md is \d+ lines/.test(trimmed)) return;

    const text = trimmed.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '');
    const terms = extractTerms(text);
    const kind = terms.length > 0 ? 'verifiable' : IMPORT.test(text) ? 'import' : 'unverifiable';
    lines.push({ file, line: index + 1, text, terms, kind });
  });
  return lines;
}

export interface LineUsage {
  used: MemoryLine[];
  unused: MemoryLine[];
  unverifiable: MemoryLine[];
}

export interface MemoryDocument {
  /** The file as shown in the report. */
  file: string;
  content: string;
  /** Sessions that loaded the file. A line can only be used where it was in the context. */
  loadedIn: ReadonlySet<string>;
}

/**
 * Sorts the lines of the memory files by use. A line is used when one of its terms appears in what
 * an agent did in a session that loaded the file: its messages, its tool calls, and the paths it
 * read or wrote.
 */
export function classifyMemoryLines(files: readonly MemoryDocument[], sessions: readonly ProfileSession[]): LineUsage {
  const corpora = new Map(sessions.map((session) => {
    const contexts = [session.main, ...session.subagents];
    const corpus = [
      ...session.agentText,
      ...contexts.flatMap((context) => context.reads.flatMap((read) => [read.target, read.scope ?? ''])),
      ...session.fileChanges.map((change) => change.path),
    ].join('\n');
    return [session.sessionId, corpus];
  }));

  const usage: LineUsage = { used: [], unused: [], unverifiable: [] };
  for (const { file, content, loadedIn } of files) {
    const where = [...loadedIn].flatMap((sessionId) => corpora.get(sessionId) ?? []);
    for (const line of memoryLines(file, content)) {
      if (line.kind === 'import') continue;
      if (line.kind === 'unverifiable') usage.unverifiable.push(line);
      else if (where.some((corpus) => line.terms.some((term) => corpus.includes(term)))) usage.used.push(line);
      else usage.unused.push(line);
    }
  }
  return usage;
}

export interface MemoryCost {
  path: string;
  type: string;
  source: 'instructions' | 'nested';
  tokens: number;
  cost: number;
}

/**
 * Rent of each memory load in a context. Memory loaded at the start pays C_mem = c·(w + r·(T − 1))
 * once per file, even if a compaction loads it again. Memory loaded on demand pays the rent of a
 * block from its turn to the end of its context.
 */
export function memoryLoadCosts(context: SessionContext, params: CostParams): MemoryCost[] {
  const turns = context.calls.length;
  if (turns === 0) return [];
  const started = new Set<string>();
  return context.memory.flatMap((load) => {
    let cost: number;
    if (load.source === 'instructions') {
      if (started.has(load.path)) return [];
      started.add(load.path);
      cost = memoryRent(load.tokens, turns, params, context.cacheTtl);
    } else if (load.turn !== undefined) {
      cost = rent(load.tokens, turnsInContext(context, load.turn), params, context.cacheTtl);
    } else {
      return [];
    }
    return [{ path: load.path, type: load.type, source: load.source, tokens: load.tokens, cost }];
  });
}
