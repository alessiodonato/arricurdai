import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCacheDir, fileLines } from '../src/chunk-cache';
import { fileChunks, loadChunks, runRecall, sessionChunks } from '../src/recall';

const user = (timestamp: string, content: unknown): string => JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content } });
const assistant = (timestamp: string, text: string): string =>
  JSON.stringify({ type: 'assistant', timestamp, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 1 } } });
const result = (timestamp: string, content: string): string => user(timestamp, [{ type: 'tool_result', tool_use_id: 't1', content }]);

const upload = [
  user('2026-10-01T09:00:00Z', 'Add a retry to the upload client'),
  result('2026-10-01T09:00:30Z', 'x'.repeat(5_000)),
  assistant('2026-10-01T09:01:00Z', 'Retry added, three attempts with a backoff.'),
];
const invoices = [user('2026-10-02T09:00:00Z', 'Why do the invoices of foreign customers fail?'), assistant('2026-10-02T09:01:00Z', 'The VAT code was missing.')];

function project() {
  const root = mkdtempSync(join(tmpdir(), 'arricurdai-cache-'));
  const dir = join(root, 'transcripts');
  mkdirSync(dir);
  writeFileSync(join(dir, 'upload.jsonl'), `${upload.join('\n')}\n`);
  writeFileSync(join(dir, 'invoices.jsonl'), `${invoices.join('\n')}\n`);
  const cache = { dir: join(root, 'cache', 'recall'), stamp: '1.0.0' };
  /** The files kept for the sessions of the project, by session. */
  const kept = (): Map<string, string> => {
    const found = new Map<string, string>();
    if (!existsSync(cache.dir)) return found;
    for (const folder of readdirSync(cache.dir)) {
      for (const name of readdirSync(join(cache.dir, folder))) if (name !== 'source.json') found.set(name.slice(0, -'.json'.length), join(cache.dir, folder, name));
    }
    return found;
  };
  return { root, dir, cache, kept };
}

const requests = (chunks: { request: string }[]): string[] => chunks.map((chunk) => chunk.request).sort();

describe('fileLines', () => {
  it('gives the lines of a file whatever the size of the pieces it reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-lines-'));
    const lines = ['a', '', 'b'.repeat(40), 'città: perché', 'c'.repeat(7), 'last, with no newline after it'];
    writeFileSync(join(dir, 'file'), lines.join('\n'));
    // Each line is read as it comes: it is good only until the next one.
    for (const piece of [1, 3, 8, 64, 4096]) expect(Array.from(fileLines(join(dir, 'file'), piece), (line) => line.toString('utf8'))).toEqual(lines);
  });
});

describe('fileChunks', () => {
  it('gives the chunks of the whole text', () => {
    const { dir } = project();
    expect(fileChunks(join(dir, 'upload.jsonl'), 'upload')).toEqual(sessionChunks(upload.join('\n'), 'upload'));
    expect(fileChunks(join(dir, 'upload.jsonl'), 'upload')[0]!.text).toContain('three attempts');
  });
});

describe('the cache of recall', () => {
  it('keeps the chunks of each transcript, and reads again only the one that changed', () => {
    const { dir, cache, kept } = project();
    const first = loadChunks(dir, undefined, cache);
    expect(requests(first.chunks)).toEqual(['Add a retry to the upload client', 'Why do the invoices of foreign customers fail?']);
    expect([...kept().keys()].sort()).toEqual(['invoices', 'upload']);
    expect(readFileSync(kept().get('upload')!, 'utf8')).not.toContain('xxxx');

    // What it kept is what it gives back: a mark left in the kept chunks shows.
    for (const path of kept().values()) writeFileSync(path, readFileSync(path, 'utf8').replace('"request":"', '"request":"KEPT '));
    expect(requests(loadChunks(dir, undefined, cache).chunks)).toEqual(['KEPT Add a retry to the upload client', 'KEPT Why do the invoices of foreign customers fail?']);

    appendFileSync(join(dir, 'upload.jsonl'), `${user('2026-10-01T10:00:00Z', 'Now add a test for the retry')}\n`);
    expect(requests(loadChunks(dir, undefined, cache).chunks)).toEqual(['Add a retry to the upload client', 'KEPT Why do the invoices of foreign customers fail?', 'Now add a test for the retry']);
  });

  it('gives the same chunks as a search with no cache', () => {
    const { dir, cache } = project();
    const plain = loadChunks(dir);
    expect(loadChunks(dir, undefined, cache)).toEqual(plain);
    expect(loadChunks(dir, undefined, cache)).toEqual(plain);
    expect(loadChunks(dir, 'upload', cache).chunks.map((chunk) => chunk.sessionId)).toEqual(['invoices']);
  });

  it('reads the transcripts again when the chunks were kept by another version', () => {
    const { dir, cache, kept } = project();
    loadChunks(dir, undefined, cache);
    for (const path of kept().values()) writeFileSync(path, readFileSync(path, 'utf8').replace('"request":"', '"request":"KEPT '));
    expect(requests(loadChunks(dir, undefined, { ...cache, stamp: '1.0.1' }).chunks)).toEqual(['Add a retry to the upload client', 'Why do the invoices of foreign customers fail?']);
  });

  it('takes away the chunks of a transcript that was deleted, and of a project that is gone', () => {
    const { dir, cache, kept, root } = project();
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'gone.jsonl'), `${invoices.join('\n')}\n`);
    loadChunks(dir, undefined, cache);
    loadChunks(other, undefined, cache);
    expect([...kept().keys()].sort()).toEqual(['gone', 'invoices', 'upload']);

    rmSync(join(dir, 'upload.jsonl'));
    rmSync(other, { recursive: true });
    loadChunks(dir, undefined, cache);
    expect([...kept().keys()]).toEqual(['invoices']);
    expect(readdirSync(cache.dir)).toHaveLength(1);
  });

  it('goes on without it when what it kept cannot be read', () => {
    const { dir, cache, kept } = project();
    loadChunks(dir, undefined, cache);
    for (const path of kept().values()) writeFileSync(path, '{ not json');
    expect(requests(loadChunks(dir, undefined, cache).chunks)).toEqual(['Add a retry to the upload client', 'Why do the invoices of foreign customers fail?']);
  });

  // Owners and modes of files, as on Linux and macOS.
  it.skipIf(process.platform === 'win32')('keeps the chunks where only this user can read them', () => {
    const { dir, cache, kept } = project();
    loadChunks(dir, undefined, cache);
    expect(statSync(cache.dir).mode & 0o777).toBe(0o700);
    for (const path of kept().values()) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('keeps nothing, and trusts nothing, in a folder that is a link to somewhere else', () => {
    const { dir, cache, root } = project();
    mkdirSync(join(root, 'cache'));
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), cache.dir);
    expect(requests(loadChunks(dir, undefined, cache).chunks)).toEqual(['Add a retry to the upload client', 'Why do the invoices of foreign customers fail?']);
    expect(readdirSync(join(root, 'elsewhere'))).toHaveLength(0);
  });

  it('is used by the command only when it is given one', async () => {
    const { dir, cache, kept } = project();
    const out: string[] = [];
    const io = { cwd: dir, env: {}, stdout: (text: string) => out.push(text), stderr: () => {}, now: () => new Date(), colors: false };
    await runRecall(['upload', 'retry'], { transcripts: dir }, io);
    expect(kept().size).toBe(0);
    await runRecall(['upload', 'retry'], { transcripts: dir }, { ...io, cache });
    expect(kept().size).toBe(2);
    expect(out[1]).toBe(out[0]);
    expect(out[0]).toContain('three attempts');
  });
});

describe('defaultCacheDir', () => {
  it('follows the custom of each system', () => {
    expect(defaultCacheDir({ HOME: '/home/dev' }, 'linux')).toBe(join('/home/dev', '.cache', 'arricurdai', 'recall'));
    expect(defaultCacheDir({ HOME: '/Users/dev' }, 'darwin')).toBe(join('/Users/dev', 'Library', 'Caches', 'arricurdai', 'recall'));
    expect(defaultCacheDir({ HOME: '/home/dev', XDG_CACHE_HOME: '/var/cache/dev' }, 'linux')).toBe(join('/var/cache/dev', 'arricurdai', 'recall'));
    expect(defaultCacheDir({ USERPROFILE: 'C:\\Users\\dev' }, 'win32')).toBeUndefined();
  });
});
