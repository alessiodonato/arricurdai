import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateTokens } from '@arricurdai/core';
import { claudeConfigDir, findTranscriptsDir } from '@arricurdai/transcripts';
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
  text: string;
}

export interface RecallHit {
  chunk: Chunk;
  score: number;
  excerpt: string;
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

/** Splits a transcript into chunks: each request with the replies and edits that followed, and compaction summaries. */
export function sessionChunks(text: string, sessionId: string): Chunk[] {
  const chunks: Chunk[] = [];
  let current: { timestamp: string | undefined; request: string; replies: string[] } | undefined;
  const flush = (): void => {
    if (current) {
      const replies = current.replies.join('\n');
      const kept = replies.length > MAX_REPLY_CHARS ? replies.slice(-MAX_REPLY_CHARS) : replies;
      chunks.push({ sessionId, timestamp: current.timestamp, request: current.request, text: `${current.request}\n${kept}` });
    }
    current = undefined;
  };
  for (const line of text.split('\n')) {
    if (line.includes('"tool_result"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
    const entry = parse(line);
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const typed = typeof content === 'string' ? content : blocks(content).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
      if (entry.isCompactSummary) {
        flush();
        for (let start = 0; start < typed.length; start += SUMMARY_PART_CHARS) {
          chunks.push({ sessionId, timestamp: entry.timestamp, request: '', text: typed.slice(start, start + SUMMARY_PART_CHARS) });
        }
      } else if (typed.trim() && !/^\s*[<[]/.test(typed)) {
        flush();
        current = { timestamp: entry.timestamp, request: typed.trim().slice(0, MAX_REQUEST_CHARS), replies: [] };
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

/** The chunks of every session in a transcript folder, except one, such as the current session. */
export function loadChunks(dir: string, exclude?: string): { chunks: Chunk[]; sessions: number } {
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl') && name !== `${exclude}.jsonl`);
  const chunks = files.flatMap((name) => sessionChunks(readFileSync(join(dir, name), 'utf8'), name.slice(0, -'.jsonl'.length)));
  return { chunks, sessions: files.length };
}

/** The lines of a chunk around the one that matches the most terms of the query. */
function excerpt(text: string, query: ReadonlySet<string>): string {
  const lines = text
    .split(/\n+/)
    .flatMap((line) => (line.length > 400 ? line.split(/(?<=[.!?;])\s+/) : [line]))
    .map((line) => line.trim())
    .filter(Boolean);
  const matches = lines.map((line) => terms(line).filter((term) => query.has(term)).length);
  let best = 0;
  matches.forEach((count, index) => {
    if (count > (matches[best] ?? 0)) best = index;
  });
  let from = best;
  let to = best + 1;
  let size = lines[best]?.length ?? 0;
  while (size < EXCERPT_CHARS && (from > 0 || to < lines.length)) {
    if (to < lines.length) size += lines[to++]!.length;
    if (size < EXCERPT_CHARS && from > 0) size += lines[--from]!.length;
  }
  const text_ = lines.slice(from, to).join('\n');
  return text_.length > EXCERPT_CHARS ? `${text_.slice(0, EXCERPT_CHARS)}…` : text_;
}

/** Ranks the chunks with BM25 (k1 = 1.2, b = 0.75). Newer chunks first on equal scores. */
export function search(chunks: readonly Chunk[], query: string, limit: number): RecallHit[] {
  const wanted = [...new Set(terms(query))];
  if (wanted.length === 0 || chunks.length === 0) return [];
  const documents = chunks.map((chunk) => terms(chunk.text));
  const averageLength = documents.reduce((total, document) => total + document.length, 0) / documents.length || 1;
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) if (wanted.includes(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const scored = documents.map((document, index) => {
    const counts = new Map<string, number>();
    for (const term of document) if (frequency.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const [term, count] of counts) {
      const df = frequency.get(term)!;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += (idf * count * 2.2) / (count + 1.2 * (0.25 + (0.75 * document.length) / averageLength));
    }
    return { chunk: chunks[index]!, score };
  });
  const query_ = new Set(wanted);
  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || String(b.chunk.timestamp).localeCompare(String(a.chunk.timestamp)))
    .slice(0, limit)
    .map((hit) => ({ ...hit, excerpt: excerpt(hit.chunk.text, query_) }));
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
    const { timestamp, sessionId, request } = hit.chunk;
    const what = request ? `request: "${oneLine(request, 120)}"` : 'compaction summary';
    const block = `[${printed.length + 1}] ${timestamp?.slice(0, 10) ?? 'undated'} · session ${sessionId.slice(0, 8)} · ${what}\n${hit.excerpt}`;
    if (printed.length > 0 && used + estimateTokens(block) > maxTokens) break;
    printed.push(block);
    used += estimateTokens(block);
  }
  const where = `${sessions} earlier session${sessions === 1 ? '' : 's'}`;
  const count = printed.length === hits.length ? `${printed.length}` : `${printed.length} of ${hits.length}`;
  const head = printed.length === 0 ? `arricurdai recall: nothing in ${where} matches "${query}".` : `arricurdai recall: ${count} matches for "${query}" in ${where}.`;
  return [head, ...printed].join('\n\n');
}

const positive = (value: string | undefined, fallback: number): number => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

/** `arricurdai recall <words...>`: prints the passages of earlier sessions that match. Leaves out the current session. */
export async function runRecall(words: readonly string[], options: RecallCommandOptions, io: CommandIO): Promise<number> {
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
  const { chunks, sessions } = loadChunks(dir, io.env.CLAUDE_CODE_SESSION_ID);
  const hits = search(chunks, query, positive(options.limit, 5));
  if (options.json) {
    const matches = hits.map(({ chunk, score, excerpt: text }) => ({ sessionId: chunk.sessionId, timestamp: chunk.timestamp, request: chunk.request, score, excerpt: text }));
    io.stdout(`${JSON.stringify({ query, sessions, matches }, null, 2)}\n`);
  } else {
    io.stdout(`${formatHits(hits, query, sessions, positive(options.maxTokens, 1_500))}\n`);
  }
  return 0;
}
