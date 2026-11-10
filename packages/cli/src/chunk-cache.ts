import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { openPrivateDir } from './private-dir';

// Recall reads every transcript of a project at each search, and nearly all of that time goes into reading
// tool results it then leaves out. This keeps the chunks of each transcript in a file of its own, and reads a
// transcript again only when it changed. The files hold text of the sessions, so they stay in a folder of this
// user alone, and go when the transcript they come from goes.

/** Where the chunks are kept, and a stamp that changes when the same transcript would give other chunks. */
export interface ChunkCache {
  dir: string;
  stamp: string;
}

interface Entry<T> {
  stamp: string;
  size: number;
  mtimeMs: number;
  chunks: T[];
}

const SOURCE = 'source.json';

/** The folder for the caches of this user, by the custom of each system. */
export function defaultCacheDir(env: Record<string, string | undefined>, platform: string = process.platform): string | undefined {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'arricurdai', 'recall');
  if (platform === 'win32') return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'arricurdai', 'Cache', 'recall') : undefined;
  if (!home) return undefined;
  return platform === 'darwin' ? join(home, 'Library', 'Caches', 'arricurdai', 'recall') : join(home, '.cache', 'arricurdai', 'recall');
}

/**
 * The lines of a file, read a piece at a time: a transcript can be larger than the longest string.
 * A line is good until the next one is asked for: it may be a view of the piece just read.
 */
export function* fileLines(path: string, pieceBytes = 4 * 1024 * 1024): Generator<Buffer> {
  const fd = openSync(path, 'r');
  try {
    const piece = Buffer.allocUnsafe(pieceBytes);
    let open: Buffer[] = [];
    for (;;) {
      const read = readSync(fd, piece, 0, pieceBytes, null);
      if (read === 0) break;
      let start = 0;
      for (let end = piece.indexOf(10, start); end >= 0 && end < read; end = piece.indexOf(10, start)) {
        const rest = piece.subarray(start, end);
        yield open.length > 0 ? Buffer.concat([...open, rest]) : rest;
        open = [];
        start = end + 1;
      }
      // The piece is written over at the next read: what is left of an open line is copied.
      if (start < read) open.push(Buffer.from(piece.subarray(start, read)));
    }
    if (open.length > 0) yield Buffer.concat(open);
  } finally {
    closeSync(fd);
  }
}

const projectFolder = (dir: string): string => `${basename(dir).replace(/[^A-Za-z0-9-]/g, '_').slice(-80)}-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`;

function readJson<T>(path: string): T | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Written whole or not at all: two searches can run at once. */
function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Takes away the chunks of transcripts that are no longer there, in every project: Claude Code deletes old transcripts, and their text must not stay here. */
function prune(cacheDir: string): void {
  for (const folder of readdirSync(cacheDir)) {
    const path = join(cacheDir, folder);
    try {
      const source = readJson<{ dir?: unknown }>(join(path, SOURCE))?.dir;
      if (typeof source !== 'string' || !existsSync(source)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      const transcripts = new Set(readdirSync(source).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)));
      for (const name of readdirSync(path)) {
        if (name !== SOURCE && !transcripts.has(name.replace(/\.json(\.\d+\.tmp)?$/, ''))) rmSync(join(path, name), { force: true });
      }
    } catch {
      // A folder it cannot read stays as it is.
    }
  }
}

/**
 * The chunks of each transcript of a folder, from the cache where the transcript has not changed since.
 * With no cache, or with one that is not a private folder of this user, it reads every transcript.
 */
export function cachedChunks<T>(dir: string, files: readonly { name: string; size: number; mtimeMs: number }[], read: (path: string, sessionId: string) => T[], cache?: ChunkCache): T[] {
  let folder: string | undefined;
  try {
    if (cache && openPrivateDir(cache.dir)) {
      const source = resolve(dir);
      const path = join(cache.dir, projectFolder(source));
      if (openPrivateDir(path)) {
        folder = path;
        if (readJson<{ dir?: unknown }>(join(path, SOURCE))?.dir !== source) writeJson(join(path, SOURCE), { dir: source });
      }
    }
  } catch {
    folder = undefined;
  }
  const chunks: T[] = [];
  for (const file of files) {
    const sessionId = file.name.slice(0, -'.jsonl'.length);
    const kept = folder && join(folder, `${sessionId}.json`);
    const entry = kept ? readJson<Entry<T>>(kept) : undefined;
    if (entry && cache && entry.stamp === cache.stamp && entry.size === file.size && entry.mtimeMs === file.mtimeMs && Array.isArray(entry.chunks)) {
      chunks.push(...entry.chunks);
      continue;
    }
    const fresh = read(join(dir, file.name), sessionId);
    chunks.push(...fresh);
    if (kept && cache) {
      try {
        writeJson(kept, { stamp: cache.stamp, size: file.size, mtimeMs: file.mtimeMs, chunks: fresh } satisfies Entry<T>);
      } catch {
        // The search does not depend on the cache.
      }
    }
  }
  if (folder && cache) {
    try {
      prune(cache.dir);
    } catch {
      // As above.
    }
  }
  return chunks;
}
