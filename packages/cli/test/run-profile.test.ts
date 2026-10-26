import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportSchema } from '@arricurdai/core';
import { afterAll, describe, expect, test } from 'vitest';
import { type CommandIO, type ProfileCommandOptions, runProfile } from '../src/run-profile';

const REPO = new URL('../../../', import.meta.url).pathname;
const FIXTURE = {
  project: join(REPO, 'fixtures/acme-shop/project'),
  transcripts: join(REPO, 'fixtures/acme-shop/claude-home/projects/-home-dev-acme-shop'),
};

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-cli-'));
  temporary.push(dir);
  return dir;
};

async function run(options: ProfileCommandOptions, env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const io: CommandIO = {
    cwd: REPO,
    env: { HOME: '/nowhere', ...env },
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    colors: false,
  };
  const code = await runProfile(options, io);
  return { code, stdout, stderr };
}

describe('arricurdai profile on the fixtures', () => {
  test('prints the summary, the top rediscoveries, the unused memory lines and where the cost goes, in this order', async () => {
    const { code, stdout, stderr } = await run(FIXTURE);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const summary = stdout.indexOf('Summary');
    const rediscoveries = stdout.indexOf('Top rediscoveries');
    const memory = stdout.indexOf('Memory lines never used in the last 3 sessions');
    expect(summary).toBeGreaterThan(-1);
    expect(rediscoveries).toBeGreaterThan(summary);
    expect(memory).toBeGreaterThan(rediscoveries);
    expect(stdout.indexOf('Where the cost goes')).toBeGreaterThan(memory);
    expect(stdout).toContain('S_max                   0.61% of the cost: a ceiling on savings, not a promise');
    expect(stdout).toContain('Mean cost K             55,728 price-weighted tokens per session');
    expect(stdout).toMatch(/ 1 {2}src\/checkout\.ts +3 +270 +621\n/);
    expect(stdout).toContain('CLAUDE.md:6  Deploy with `scripts/deploy.sh --prod` from the main branch only.');
  });

  test('counts the broken lines instead of failing', async () => {
    const { code, stdout } = await run(FIXTURE);
    expect(code).toBe(0);
    expect(stdout).toContain('Lines skipped           5 of 109: 3 malformed, 1 of unknown type "future-feature", 1 "assistant" with missing fields');
  });

  test('--json prints the same report, valid against the schema exported by core', async () => {
    const { code, stdout } = await run({ ...FIXTURE, json: true });
    expect(code).toBe(0);
    const report = reportSchema.parse(JSON.parse(stdout));
    expect(report.summary.totalCost).toBe(167185);
    expect(report.generatedAt).toBe('2026-10-26T12:00:00.000Z');
  });

  test('--sessions limits the sessions measured', async () => {
    const { stdout } = await run({ ...FIXTURE, json: true, sessions: '1' });
    expect(JSON.parse(stdout).window).toMatchObject({ sessions: 1, available: 3 });
  });

  test('reads the cost parameters from arricurdai.config.json in the project', async () => {
    const project = tempDir();
    writeFileSync(join(project, 'arricurdai.config.json'), JSON.stringify({ w1h: 1.25 }));
    const { code, stdout } = await run({ project, transcripts: FIXTURE.transcripts, json: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).params).toEqual({ w: 1.25, w1h: 1.25, r: 0.1, mu: 5, overhead: 300 });
  });

  test('finds the transcripts from the project path in CLAUDE_CONFIG_DIR', async () => {
    const claudeDir = tempDir();
    // The command resolves symbolic links, like the cwd Claude Code records (on macOS /var is /private/var).
    const project = realpathSync(tempDir());
    const encoded = project.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(claudeDir, 'projects', encoded), { recursive: true });
    writeFileSync(join(claudeDir, 'projects', encoded, 's1.jsonl'), '');
    const { code, stdout } = await run({ project, json: true }, { CLAUDE_CONFIG_DIR: claudeDir });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).project.transcripts).toBe(join(claudeDir, 'projects', encoded));
  });
});

describe('arricurdai profile on bad input', () => {
  const expectOneLineError = (stderr: string, message: string | RegExp): void => {
    expect(stderr).toMatch(message);
    expect(stderr).not.toMatch(/\n\s+at /);
  };

  test('a wrong --sessions', async () => {
    const { code, stderr } = await run({ ...FIXTURE, sessions: '0' });
    expect(code).toBe(1);
    expectOneLineError(stderr, 'arricurdai: --sessions must be a whole number of 1 or more, got "0"');
  });

  test('a project that does not exist', async () => {
    const { code, stderr } = await run({ project: '/no/such/folder' });
    expect(code).toBe(1);
    expectOneLineError(stderr, 'arricurdai: Project folder not found: /no/such/folder');
  });

  test('a project with no transcripts', async () => {
    const { code, stderr } = await run({ project: tempDir() }, { CLAUDE_CONFIG_DIR: tempDir() });
    expect(code).toBe(1);
    expectOneLineError(stderr, /no Claude Code transcripts found for .*--transcripts <dir>/);
  });

  test('a config file with a wrong field, or missing, or not JSON', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ w: 'high' }));
    writeFileSync(join(dir, 'broken.json'), '{ w: ');
    const wrong = await run({ ...FIXTURE, config: join(dir, 'bad.json') });
    expect(wrong.code).toBe(1);
    expectOneLineError(wrong.stderr, /bad\.json: Invalid arricurdai config\. w: /);
    expectOneLineError((await run({ ...FIXTURE, config: join(dir, 'missing.json') })).stderr, /cannot read the config file .*missing\.json/);
    expectOneLineError((await run({ ...FIXTURE, config: join(dir, 'broken.json') })).stderr, /broken\.json is not valid JSON/);
  });
});
