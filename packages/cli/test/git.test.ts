import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadGitHistory } from '../src/git';

const temporary: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-git-'));
  temporary.push(dir);
  return dir;
};

function git(dir: string, args: string[], date?: string): void {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, stdio: 'ignore' });
}

let repo: string;

beforeAll(() => {
  repo = tempDir();
  git(repo, ['init', '-q']);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'a1');
  writeFileSync(join(repo, 'src/b.ts'), 'b1');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'first'], '2026-09-01T09:00:00Z');
  writeFileSync(join(repo, 'src/a.ts'), 'a2');
  git(repo, ['commit', '-q', '-am', 'change a'], '2026-09-02T12:00:00Z');
  // Next.js routes put brackets and parentheses in real paths.
  mkdirSync(join(repo, 'app/[id]'), { recursive: true });
  mkdirSync(join(repo, 'app/(auth)/login'), { recursive: true });
  writeFileSync(join(repo, 'app/[id]/page.tsx'), 'p');
  writeFileSync(join(repo, 'app/(auth)/login/page.tsx'), 'l');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'routes'], '2026-09-02T13:00:00Z');
});

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe('loadGitHistory', () => {
  test('tells whether a file changed in a commit between two times', async () => {
    const history = await loadGitHistory(repo);
    expect(history?.changedBetween('src/a.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(true);
    expect(history?.changedBetween('src/b.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(false);
    expect(history?.changedBetween('src/a.ts', '2026-09-02T13:00:00Z', '2026-09-03T00:00:00Z')).toBe(false);
    expect(history?.changedBetween('./src/a.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(true);
  });

  test('matches globs, as a shell command may read src/*.ts', async () => {
    const history = await loadGitHistory(repo);
    expect(history?.changedBetween('src/*.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(true);
    expect(history?.changedBetween('lib/*.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(false);
  });

  test('reads brackets and parentheses in paths literally, as in Next.js routes', async () => {
    const history = await loadGitHistory(repo);
    const changed = (path: string) => history?.changedBetween(path, '2026-09-02T12:30:00Z', '2026-09-03T00:00:00Z');
    expect(changed('app/[id]/page.tsx')).toBe(true);
    expect(changed('app/(auth)/login/page.tsx')).toBe(true);
    expect(changed('app/[id]/*.tsx')).toBe(true);
    expect(changed('app/[other]/page.tsx')).toBe(false);
  });

  test('cannot tell for paths outside the project or for bad times', async () => {
    const history = await loadGitHistory(repo);
    expect(history?.changedBetween('/etc/hosts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBeUndefined();
    expect(history?.changedBetween('../other/a.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBeUndefined();
    expect(history?.changedBetween('src/a.ts', 'not a time', '2026-09-03T00:00:00Z')).toBeUndefined();
  });

  test('gives paths relative to a project in a subfolder of the repository', async () => {
    const history = await loadGitHistory(join(repo, 'src'));
    expect(history?.changedBetween('a.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(true);
  });

  test('reads only the commits after `since`', async () => {
    const history = await loadGitHistory(repo, '2026-09-02T13:00:00Z');
    expect(history?.changedBetween('src/a.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(false);
  });

  test('returns undefined outside a git work tree', async () => {
    expect(await loadGitHistory(tempDir())).toBeUndefined();
  });

  test('a repository with no commits has nothing that changed', async () => {
    const empty = tempDir();
    git(empty, ['init', '-q']);
    expect((await loadGitHistory(empty))?.changedBetween('a.ts', '2026-09-01T10:00:00Z', '2026-09-03T00:00:00Z')).toBe(false);
  });
});
