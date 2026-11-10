import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateTokens } from '@arricurdai/core';
import { claudeConfigDir, findTranscriptsDir } from '@arricurdai/transcripts';
import { cachedChunks, type ChunkCache, fileLines } from './chunk-cache';
import { typedPrompt, typedText } from './prompts';
import type { CommandIO } from './run-profile';

// Lexical search over the earlier sessions of a project, so that an agent can keep a small context and still
// find what was asked, decided and changed. BM25 over chunks: a request with the replies to it, or a part of a
// compaction summary. Tool results are left out: the files they show can be read again. Local files only.

/** A piece of an earlier session that a search can return. */
export interface Chunk {
  sessionId: string;
  timestamp: string | undefined;
  /** The request the replies answer. Empty for a part of a compaction summary. */
  request: string;
  /** Some of the request was pasted text: it may be a log or a message, not words of the user. */
  pasted?: boolean;
  text: string;
}

export interface RecallHit {
  chunk: Chunk;
  score: number;
  /** The request of the chunk, with its secrets hidden. */
  request: string;
  /** The share of the query that the excerpt holds, weighting each term by how rare it is: from 0 to 1. */
  coverage: number;
  excerpt: string;
}

/** The command, with the place where it may keep the chunks of the transcripts it read. */
export interface RecallIO extends CommandIO {
  cache?: ChunkCache;
}

export interface RecallCommandOptions {
  project?: string;
  transcripts?: string;
  limit?: string;
  maxTokens?: string;
  json?: boolean;
}

const MAX_REQUEST_CHARS = 1_000;
/** The end of a long exchange is kept: it usually says what was done and decided. */
const MAX_REPLY_CHARS = 5_000;
const SUMMARY_PART_CHARS = 2_000;
const EXCERPT_CHARS = 700;
/** Two excerpts that share more of their terms than this say the same thing: successive compaction summaries repeat each other. */
const SAME_EXCERPT = 0.6;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const STOPWORDS = new Set((
  'the a an and or of to in on for with is are was were be been it its this that these those as at by from we you i ' +
  'not no do does did can could should would will if then so but what how why when where which there here have has had ' +
  'all any our your my me us they them into also just now more use using get let make need want ' +
  'il lo la gli le un uno una di da con su per tra fra ed che chi cui non si ci ne mi ti vi del della dei delle degli ' +
  'dello al alla ai alle agli allo dal dalla dai dalle nel nella nei nelle sul sulla sui sulle sono era essere ha hanno ' +
  'ho abbiamo come cosa dove quando perché perche anche ma se questo questa questi queste quello quella più piu poi già ' +
  'gia ancora tutto tutti fare fatto dobbiamo possiamo puoi voglio va sì'
).split(' '));

interface Entry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function parse(line: string): Entry | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? (value as Entry) : undefined;
  } catch {
    return undefined;
  }
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

/** Folds the endings that change between singular and plural, in Italian and English. */
function stem(word: string): string {
  if (word.length > 8 && /azion[ei]$/.test(word)) return word.slice(0, -6);
  let stemmed = word;
  if (stemmed.length > 5 && stemmed.endsWith('ing')) stemmed = stemmed.slice(0, -3);
  else if (stemmed.length > 4 && stemmed.endsWith('ed')) stemmed = stemmed.slice(0, -2);
  else if (stemmed.length > 3 && stemmed.endsWith('s') && !stemmed.endsWith('ss')) stemmed = stemmed.slice(0, -1);
  if (stemmed.length > 4 && /[aeio]$/.test(stemmed)) stemmed = stemmed.slice(0, -1);
  return stemmed;
}

/** The search terms of a text: words and identifiers, also split at camelCase and underscores, without common words. */
export function terms(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const parts = raw.includes('_') || /[a-z][A-Z]/.test(raw) ? [raw, ...raw.split(/_|(?<=[a-z])(?=[A-Z])/)] : [raw];
    for (const part of parts) {
      const word = part.toLowerCase();
      if (word.length < 2 || STOPWORDS.has(word) || (/^\d+$/.test(word) && word.length < 3)) continue;
      found.push(stem(word));
    }
  }
  return found;
}

/** A line of a summary, or its pieces between words when it is too long for one part. */
function linePieces(line: string): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > SUMMARY_PART_CHARS) {
    const space = rest.lastIndexOf(' ', SUMMARY_PART_CHARS);
    const end = space > 0 ? space : SUMMARY_PART_CHARS;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  return [...pieces, rest];
}

/** A compaction summary in parts of whole lines: a cut inside a line would show half a word, and part of a secret away from its key. */
function summaryParts(summary: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const line of summary.split('\n').flatMap(linePieces)) {
    if (part && part.length + 1 + line.length > SUMMARY_PART_CHARS) {
      parts.push(part);
      part = '';
    }
    part = part ? `${part}\n${line}` : line;
  }
  return part.trim() ? [...parts, part] : parts;
}

/**
 * Changes when the same transcript would give other chunks: the chunks kept from an earlier version are then read again.
 * Raise it with any change to what `sessionChunks` returns.
 */
export const CHUNKS_VERSION = 1;

const USER_LINE = '"type":"user"';
const ASSISTANT_LINE = '"type":"assistant"';
const RESULT_LINE = '"tool_result"';

/** Splits a transcript into chunks: each request with the replies and edits that followed, and compaction summaries. */
export function sessionChunks(text: string, sessionId: string): Chunk[] {
  return chunksOfLines(text.split('\n'), sessionId);
}

/** The lines of a transcript file that can hold a prompt or a reply. The others, mostly tool results, are not even decoded. */
function* promptLines(path: string): Generator<string> {
  for (const line of fileLines(path)) {
    if (!line.includes(RESULT_LINE) && (line.includes(USER_LINE) || line.includes(ASSISTANT_LINE))) yield line.toString('utf8');
  }
}

/** The chunks of a transcript file, read a piece at a time. */
export function fileChunks(path: string, sessionId: string): Chunk[] {
  return chunksOfLines(promptLines(path), sessionId);
}

function chunksOfLines(lines: Iterable<string>, sessionId: string): Chunk[] {
  const chunks: Chunk[] = [];
  let current: { timestamp: string | undefined; request: string; pasted: boolean; replies: string[] } | undefined;
  const flush = (): void => {
    if (current) {
      const replies = current.replies.join('\n');
      // Cut between lines: a cut inside one could leave a secret here and its key out.
      const cut = Math.max(replies.length - MAX_REPLY_CHARS, 0);
      const line = cut === 0 ? -1 : replies.indexOf('\n', cut);
      const kept = replies.slice(line < 0 ? cut : line + 1);
      const pasted = current.pasted ? { pasted: true } : {};
      chunks.push({ sessionId, timestamp: current.timestamp, request: current.request, ...pasted, text: `${current.request}\n${kept}` });
    }
    current = undefined;
  };
  for (const line of lines) {
    if (line.includes(RESULT_LINE) || !(line.includes(USER_LINE) || line.includes(ASSISTANT_LINE))) continue;
    const entry = parse(line);
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      if (entry.isCompactSummary) {
        flush();
        for (const part of summaryParts(typedText(content))) chunks.push({ sessionId, timestamp: entry.timestamp, request: '', text: part });
        continue;
      }
      const prompt = typedPrompt(content);
      if (prompt) {
        flush();
        current = { timestamp: entry.timestamp, request: prompt.text.slice(0, MAX_REQUEST_CHARS), pasted: prompt.pasted, replies: [] };
      }
    } else if (entry.type === 'assistant' && current) {
      for (const block of blocks(content)) {
        if (block.type === 'text' && block.text?.trim()) current.replies.push(block.text.trim());
        const path = block.input?.file_path;
        if (block.type === 'tool_use' && typeof path === 'string' && EDIT_TOOLS.has(block.name ?? '')) current.replies.push(`[${block.name} ${path}]`);
      }
    }
  }
  flush();
  return chunks;
}

/**
 * The chunks of every session in a transcript folder, except one, such as the current session.
 * With a cache, it reads only the transcripts that changed since the last search.
 */
export function loadChunks(dir: string, exclude?: string, cache?: ChunkCache): { chunks: Chunk[]; sessions: number } {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl') && name !== `${exclude}.jsonl`)
    .flatMap((name) => {
      try {
        const stats = statSync(join(dir, name));
        return stats.isFile() ? [{ name, size: stats.size, mtimeMs: stats.mtimeMs }] : [];
      } catch {
        // Deleted since the folder was listed.
        return [];
      }
    });
  const stamp = cache && { dir: cache.dir, stamp: `${CHUNKS_VERSION}:${cache.stamp}` };
  return { chunks: cachedChunks(dir, files, fileChunks, stamp), sessions: files.length };
}

const REDACTED = '[redacted]';
/** Secrets with a shape of their own: private keys, JWTs, bearer tokens and the keys of common services. */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  /\bBearer\s+[\w.~+/-]{20,}=*/g,
  /\b(?:sk-[\w-]{20,}|x(?:keysib|smtpsib)-[\w-]{20,}|gh[pousr]_\w{30,}|github_pat_\w{30,}|xox[abposr]-[\w-]{10,}|[rs]k_(?:live|test)_\w{16,}|whsec_[\w+/=]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35})/g,
];
/** The password in a URL such as postgresql://user:password@host. */
const URL_PASSWORD = /(\b[a-z][\w+.-]*:\/\/[^\s:/@]*:)([^\s/@]+)(?=@)/gi;
/** The password after an email, in a pair such as `user@example.com` / `password`. */
const EMAIL_PASSWORD = /(\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+`?\s*\/\s*`?)([^\s`'"/@,;|]{6,})/g;
/** A line about passwords, where a value written as code is likely one: `password \`…\``, `password — \`…\``, a list. */
const PASSWORD_LINE = /\b(?:password|passwd|pwd|pw|credenziali|credentials)\b/i;
const CODE_VALUE = /`([^`\s]{6,})`/g;
/** Code in such a line that is not a password: an email, a name in capitals, lowercase words joined by _ or -, a commit, a path, a file, a call, a module or a setting. */
const NOT_PASSWORD = /@|^[A-Z0-9_]+$|^[a-z]+(?:[_-][a-z]+)+$|^[0-9a-f]{7,40}$|[/.(:=]/;
/** A value given to a key that names a secret: in code or a table (`SESSION_SECRET=…`) and in prose (`Password: …`, `la password è …`). */
const KEYED_SECRETS = [
  /(\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY)[A-Z0-9_]*[`'"]*(?:=[`'"]?|\s*=\s*[`'"]|\s*[:|][\s`'"]*))([^\s`'"|,;]{6,})/g,
  /(\b(?:password|passwd|pwd|pw|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|chiave (?:api|segreta|privata))\b(?: \p{L}+){0,3}[\s*`'"]*(?::|=|è|e'|is\b|—|–)[\s*`'"]*)([^\s`'"*|,;]{6,})/giu,
];
/** Values after such a key that are not secrets: a word or an identifier, a number, a path, a reference or code. */
const NOT_SECRET = /^(?:\p{Ll}\p{L}*|\p{Lu}\p{Ll}+|[\d.,%+-]+|[$~./].*|.*[(].*|.*\b(?:process|env|environ)\b.*)$/u;
/** Tests a value without the punctuation that may close the sentence after it, as in «la password è sbagliata». */
const notSecret = (value: string): boolean => NOT_SECRET.test(value.replace(/[.,:;!?»”"')\]]+$/u, ''));

/** The text with the secrets it shows replaced by [redacted], so that a search does not bring them back. `found` collects them. */
export function redact(text: string, found?: Set<string>): string {
  const hide = (value: string): string => {
    found?.add(value);
    return REDACTED;
  };
  let result = text;
  for (const shape of SECRET_SHAPES) result = result.replace(shape, (match) => hide(match));
  result = result.replace(URL_PASSWORD, (_match, before: string, value: string) => `${before}${hide(value)}`);
  result = result.replace(EMAIL_PASSWORD, (match, before: string, value: string) => (notSecret(value) ? match : `${before}${hide(value)}`));
  for (const keyed of KEYED_SECRETS) result = result.replace(keyed, (match, key: string, value: string) => (notSecret(value) ? match : `${key}${hide(value)}`));
  return result
    .split('\n')
    .map((line) => (PASSWORD_LINE.test(line) ? line.replace(CODE_VALUE, (match, value: string) => (notSecret(value) || NOT_PASSWORD.test(value) ? match : `\`${hide(value)}\``)) : line))
    .join('\n');
}

/**
 * A value that can be hidden everywhere: at least 6 characters, with a digit or a symbol next to letters or digits.
 * Letters alone may be a word, as in postgres://app:postgres@host, and symbols alone a mask or markup, such as ******.
 */
const distinctive = (value: string): boolean => value.length >= 6 && /[\p{L}\p{N}]/u.test(value) && /\d|[^\p{L}\p{N}_-]/u.test(value) && !value.includes(REDACTED);

/** The secrets recognized in the chunks that are safe to hide wherever they appear, longest first. */
export function knownSecrets(chunks: readonly Chunk[]): string[] {
  const found = new Set<string>();
  for (const chunk of chunks) redact(chunk.text, found);
  return [...found].filter(distinctive).sort((a, b) => b.length - a.length);
}

/** The text with its secrets hidden, and the secrets known from elsewhere, which may appear here with no key next to them. */
export function hideSecrets(text: string, known: readonly string[]): string {
  return known.reduce((clean, value) => clean.replaceAll(value, REDACTED), redact(text));
}

/** The lines of a chunk, with its secrets already hidden, around the one that matches the query best: the rarer the terms it shares, the better. */
function excerpt(text: string, weights: ReadonlyMap<string, number>): string {
  const lines = text
    .split(/\n+/)
    .flatMap((line) => (line.length > 400 ? line.split(/(?<=[.!?;])\s+/) : [line]))
    .map((line) => line.trim())
    .filter(Boolean);
  const matches = lines.map((line) => [...new Set(terms(line))].reduce((total, term) => total + (weights.get(term) ?? 0), 0));
  let best = 0;
  matches.forEach((count, index) => {
    if (count > (matches[best] ?? 0)) best = index;
  });
  let from = best;
  let to = best + 1;
  let size = lines[best]?.length ?? 0;
  // Whole lines around the best one, while they fit: the best line is never cut away.
  for (let grew = true; grew; ) {
    grew = false;
    if (to < lines.length && size + 1 + lines[to]!.length <= EXCERPT_CHARS) {
      size += 1 + lines[to++]!.length;
      grew = true;
    }
    if (from > 0 && size + 1 + lines[from - 1]!.length <= EXCERPT_CHARS) {
      size += 1 + lines[--from]!.length;
      grew = true;
    }
  }
  const shown = lines.slice(from, to).join('\n');
  return shown.length > EXCERPT_CHARS ? `${shown.slice(0, EXCERPT_CHARS)}…` : shown;
}

/** The share of the terms of two excerpts that both hold: from 0 to 1. */
function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0;
  for (const term of a) if (b.has(term)) both++;
  return both / (a.size + b.size - both || 1);
}

/**
 * Ranks the chunks with BM25 (k1 = 1.2, b = 0.75). Newer chunks first on equal scores.
 * With `minCoverage`, a chunk counts only when its excerpt holds at least that share of the query: a long chunk can
 * contain every word of a query by chance, scattered across replies on other subjects.
 * A chunk whose excerpt repeats one already found is left out, for the next in the ranking.
 */
export function search(chunks: readonly Chunk[], query: string, limit: number, minCoverage = 0): RecallHit[] {
  const wanted = [...new Set(terms(query))];
  if (wanted.length === 0 || chunks.length === 0) return [];
  const documents = chunks.map((chunk) => terms(chunk.text));
  const averageLength = documents.reduce((total, document) => total + document.length, 0) / documents.length || 1;
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) if (wanted.includes(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const weights = new Map(wanted.map((term) => {
    const df = frequency.get(term) ?? 0;
    return [term, Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))] as const;
  }));
  const scored = documents.map((document, index) => {
    const counts = new Map<string, number>();
    for (const term of document) if (frequency.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const [term, count] of counts) score += (weights.get(term)! * count * 2.2) / (count + 1.2 * (0.25 + (0.75 * document.length) / averageLength));
    return { chunk: chunks[index]!, score };
  });
  const ranked = scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || String(b.chunk.timestamp).localeCompare(String(a.chunk.timestamp)));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const known = knownSecrets(chunks);
  const hits: RecallHit[] = [];
  const found: Set<string>[] = [];
  // For each chunk it leaves out it looks further down the ranking, up to ten times the limit.
  for (const hit of ranked.slice(0, limit * 10)) {
    // The whole chunk first: what makes a secret recognizable may be outside the lines that are shown.
    const shown = excerpt(hideSecrets(hit.chunk.text, known), weights);
    const held = new Set(terms(shown));
    const coverage = [...weights].reduce((sum, [term, weight]) => sum + (held.has(term) ? weight : 0), 0) / total;
    if (coverage < minCoverage || found.some((other) => shared(held, other) > SAME_EXCERPT)) continue;
    found.push(held);
    hits.push({ ...hit, request: hideSecrets(hit.chunk.request, known), coverage, excerpt: shown });
    if (hits.length === limit) break;
  }
  return hits;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

/** The matches as text, within a token budget. The first match is always printed. */
export function formatHits(hits: readonly RecallHit[], query: string, sessions: number, maxTokens: number): string {
  const printed: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const { timestamp, sessionId } = hit.chunk;
    const asked = hit.chunk.pasted ? 'request, with pasted text' : 'request';
    const what = hit.request ? `${asked}: "${oneLine(hit.request, 120)}"` : 'compaction summary';
    const block = `[${printed.length + 1}] ${timestamp?.slice(0, 10) ?? 'undated'} · session ${sessionId.slice(0, 8)} · ${what}\n${hit.excerpt}`;
    if (printed.length > 0 && used + estimateTokens(block) > maxTokens) break;
    printed.push(block);
    used += estimateTokens(block);
  }
  const where = `${sessions} earlier session${sessions === 1 ? '' : 's'}`;
  const count = printed.length === hits.length ? `${printed.length}` : `${printed.length} of ${hits.length}`;
  const asked = redact(query);
  const head = printed.length === 0 ? `arricurdai recall: nothing in ${where} matches "${asked}".` : `arricurdai recall: ${count} matches for "${asked}" in ${where}.`;
  return [head, ...printed].join('\n\n');
}

const positive = (value: string | undefined, fallback: number): number => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

/** `arricurdai recall <words...>`: prints the passages of earlier sessions that match. Leaves out the current session. */
export async function runRecall(words: readonly string[], options: RecallCommandOptions, io: RecallIO): Promise<number> {
  const query = words.join(' ').trim();
  if (query === '') {
    io.stderr('arricurdai: recall needs words to look for, such as: arricurdai recall "upload retry"\n');
    return 2;
  }
  let dir: string | undefined;
  if (options.transcripts) {
    dir = resolve(io.cwd, options.transcripts);
  } else {
    let root: string;
    try {
      root = realpathSync(resolve(io.cwd, options.project ?? '.'));
    } catch {
      io.stderr(`arricurdai: the project folder ${options.project ?? '.'} does not exist.\n`);
      return 2;
    }
    dir = (await findTranscriptsDir(root, claudeConfigDir(io.env)))?.dir;
  }
  if (!dir) {
    io.stderr('arricurdai: found no Claude Code transcripts for this project.\n');
    return 1;
  }
  const { chunks, sessions } = loadChunks(dir, io.env.CLAUDE_CODE_SESSION_ID, io.cache);
  const hits = search(chunks, query, positive(options.limit, 5));
  if (options.json) {
    const matches = hits.map(({ chunk, request, score, excerpt: text }) => ({ sessionId: chunk.sessionId, timestamp: chunk.timestamp, request, score, excerpt: text }));
    io.stdout(`${JSON.stringify({ query: redact(query), sessions, matches }, null, 2)}\n`);
  } else {
    io.stdout(`${formatHits(hits, query, sessions, positive(options.maxTokens, 1_500))}\n`);
  }
  return 0;
}
