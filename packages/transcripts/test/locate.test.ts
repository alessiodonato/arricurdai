import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { claudeConfigDir, encodeProjectPath, findTranscriptsDir, listSessionFiles } from '../src/index';

const FIXTURE_TRANSCRIPTS = new URL('../../../fixtures/acme-shop/claude-home/projects/-home-dev-acme-shop', import.meta.url).pathname;

describe('claudeConfigDir', () => {
  test('follows CLAUDE_CONFIG_DIR, like Claude Code', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/claude' })).toBe('/custom/claude');
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });
});

describe('encodeProjectPath', () => {
  test('replaces every character that is not a letter or a digit with -', () => {
    expect(encodeProjectPath('/Users/me/Desktop/arricurdAI')).toBe('-Users-me-Desktop-arricurdAI');
    // Observed with Claude Code 2.1.310 on a folder with a space, dots, an underscore and parentheses.
    expect(encodeProjectPath('/tmp/enc test/My.App_v2 (copy)')).toBe('-tmp-enc-test-My-App-v2--copy-');
  });
});

describe('findTranscriptsDir', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function claudeHome(projects: Record<string, string | undefined>): string {
    const home = mkdtempSync(join(tmpdir(), 'arricurdai-'));
    temporary.push(home);
    for (const [name, cwd] of Object.entries(projects)) {
      mkdirSync(join(home, 'projects', name), { recursive: true });
      if (cwd !== undefined) writeFileSync(join(home, 'projects', name, 's1.jsonl'), `${JSON.stringify({ type: 'user', cwd })}\n`);
    }
    return home;
  }

  test('finds the folder named after the project path', async () => {
    const home = claudeHome({ '-work-shop': '/work/shop' });
    expect(await findTranscriptsDir('/work/shop', home)).toEqual({ dir: join(home, 'projects', '-work-shop'), matchedBy: 'path' });
  });

  test('when two paths encode to the same name, picks the folder whose sessions ran in the project', async () => {
    const home = claudeHome({ '-work-my-shop': '/work/my/shop', 'renamed-folder': '/work/my-shop' });
    expect(await findTranscriptsDir('/work/my-shop', home)).toEqual({ dir: join(home, 'projects', 'renamed-folder'), matchedBy: 'cwd' });
  });

  test('returns undefined when no folder matches', async () => {
    const home = claudeHome({ '-elsewhere': '/elsewhere' });
    expect(await findTranscriptsDir('/work/shop', home)).toBeUndefined();
    expect(await findTranscriptsDir('/work/shop', join(home, 'missing'))).toBeUndefined();
  });
});

describe('listSessionFiles', () => {
  test('lists the sessions of the fixtures with their subagents', async () => {
    const sessions = await listSessionFiles(FIXTURE_TRANSCRIPTS);
    expect(sessions.map((s) => s.sessionId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
    expect(sessions[1]?.subagents).toEqual([{
      agentId: 'a1b2c3d4e5f6a7b8c',
      file: join(FIXTURE_TRANSCRIPTS, '22222222-2222-4222-8222-222222222222', 'subagents', 'agent-a1b2c3d4e5f6a7b8c.jsonl'),
      metaFile: join(FIXTURE_TRANSCRIPTS, '22222222-2222-4222-8222-222222222222', 'subagents', 'agent-a1b2c3d4e5f6a7b8c.meta.json'),
    }]);
  });

  test('attaches a top-level agent file to the session named in its lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-'));
    try {
      writeFileSync(join(dir, 'abc.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 'abc' })}\n`);
      writeFileSync(join(dir, 'agent-x1.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 'abc', isSidechain: true })}\n`);
      const sessions = await listSessionFiles(dir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.subagents.map((s) => s.agentId)).toEqual(['x1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
