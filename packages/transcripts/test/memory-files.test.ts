import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { discoverMemoryFiles } from '../src/index';

const FIXTURES = new URL('../../../fixtures/acme-shop/', import.meta.url).pathname;
const PROJECT = join(FIXTURES, 'project');
const TRANSCRIPTS = join(FIXTURES, 'claude-home/projects/-home-dev-acme-shop');

describe('discoverMemoryFiles on the fixtures', () => {
  test('finds the files the transcripts record, in the same order', () => {
    const files = discoverMemoryFiles(PROJECT, { claudeDir: join(FIXTURES, 'claude-home'), transcriptsDir: TRANSCRIPTS, stopAt: PROJECT });
    expect(files.map((f) => [f.type, f.path.slice(FIXTURES.length)])).toEqual([
      ['User', 'claude-home/CLAUDE.md'],
      ['Project', 'project/CLAUDE.md'],
      ['Project', 'project/docs/conventions.md'],
      ['Project', 'project/.claude/CLAUDE.md'],
      ['Project', 'project/.claude/rules/testing.md'],
      ['Local', 'project/CLAUDE.local.md'],
      ['AutoMem', 'claude-home/projects/-home-dev-acme-shop/memory/MEMORY.md'],
    ]);
    expect(files[1]?.content.endsWith('See @docs/conventions.md for code style.')).toBe(true);
  });
});

describe('discoverMemoryFiles', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'arricurdai-memory-'));
    temporary.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  test('reads CLAUDE.md from the parent folders first, and CLAUDE.local.md after the rules', () => {
    const root = tree({
      'CLAUDE.md': 'parent', 'app/CLAUDE.md': 'project', 'app/CLAUDE.local.md': 'local', 'app/.claude/rules/a.md': 'rule',
    });
    const files = discoverMemoryFiles(join(root, 'app'), { claudeDir: join(root, 'no-claude'), stopAt: root });
    expect(files.map((f) => [f.type, f.content])).toEqual([['Project', 'parent'], ['Project', 'project'], ['Project', 'rule'], ['Local', 'local']]);
  });

  test('skips the rules limited to some paths, and folders above stopAt', () => {
    const root = tree({
      'CLAUDE.md': 'above', 'app/.claude/rules/always.md': 'always',
      'app/.claude/rules/scoped.md': '---\npaths: src/**\n---\nonly for src',
    });
    expect(discoverMemoryFiles(join(root, 'app'), { claudeDir: join(root, 'x'), stopAt: join(root, 'app') }).map((f) => f.content)).toEqual(['always']);
  });

  test('follows imports, ignores the ones in code, and stops on cycles', () => {
    const root = tree({
      'CLAUDE.md': 'See @docs/a.md and `@docs/not-this.md`.',
      'docs/a.md': 'A, see @b.md',
      'docs/b.md': 'B, back to @a.md',
      'docs/not-this.md': 'never',
    });
    expect(discoverMemoryFiles(root, { claudeDir: join(root, 'x'), stopAt: root }).map((f) => f.path.slice(root.length))).toEqual([
      '/CLAUDE.md', '/docs/a.md', '/docs/b.md',
    ]);
  });

  test('loads only the first 200 lines of MEMORY.md', () => {
    const lines = Array.from({ length: 210 }, (_, i) => `line ${i + 1}`).join('\n');
    const root = tree({ 'transcripts/memory/MEMORY.md': `${lines}\n` });
    const [memory] = discoverMemoryFiles(join(root, 'app'), { claudeDir: join(root, 'x'), transcriptsDir: join(root, 'transcripts'), stopAt: root });
    expect(memory?.type).toBe('AutoMem');
    expect(memory?.content.split('\n')).toHaveLength(200);
    expect(memory?.content.split('\n').at(-1)).toBe('line 200');
  });
});
