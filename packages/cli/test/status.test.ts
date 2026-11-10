import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addToday, readSince, readStatus, renderStatus, renderSwiftBar, runStatus, type Status, type TodayStatus } from '../src/status';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Local times, so that "today" starts at the local midnight whatever the time zone of the test.
const NOW = new Date(2026, 9, 26, 12, 0, 0);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const SECRET = 'PROMPT-TEXT-NEVER-SHOWN';

const usage = (context: number, output = 100) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 1_000,
  cache_read_input_tokens: context - 1_002,
  output_tokens: output,
  cache_creation: { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 },
});
const assistant = (cwd: string, at: Date, id: string, use: object, model = 'claude-opus-5-5'): string =>
  JSON.stringify({ type: 'assistant', cwd, timestamp: at.toISOString(), message: { id, model, content: [{ type: 'text', text: SECRET }], usage: use } });
const user = (cwd: string, at: Date): string => JSON.stringify({ type: 'user', cwd, timestamp: at.toISOString(), message: { role: 'user', content: SECRET } });
const guardStop = (cwd: string, at: Date): string =>
  JSON.stringify({ type: 'system', subtype: 'informational', cwd, timestamp: at.toISOString(), content: 'arricurdai: this session was idle for 3h 0m and its prompt cache expired.' });

/** A Claude Code config folder with invented sessions of three projects, and one session too old to show. */
function claudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-status-'));
  const write = (project: string, file: string, lines: string[], modified: Date): void => {
    const path = join(dir, 'projects', project, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);
    utimesSync(path, modified, modified);
  };
  const shop = '/work/shop-api';
  write('-work-shop-api', 'aaaa1111.jsonl', [
    assistant(shop, ago(14 * HOUR), 'msg-yesterday', usage(200_000)),
    user(shop, ago(30 * MINUTE)),
    // One call, written as two lines: one for each part of the reply.
    assistant(shop, ago(21 * MINUTE), 'msg-1', usage(312_000)),
    assistant(shop, ago(20 * MINUTE), 'msg-1', usage(312_000)),
    // A cd into a subfolder: the session still belongs to the project it started in.
    user(`${shop}/web`, ago(20 * MINUTE)),
  ], ago(20 * MINUTE));
  write('-work-shop-api', 'aaaa1111/subagents/agent-x1.jsonl', [
    assistant(shop, ago(25 * MINUTE), 'msg-sub', usage(20_000), 'claude-next-9'),
    guardStop(shop, ago(25 * MINUTE)),
  ], ago(25 * MINUTE));
  write('-work-blog', 'bbbb2222.jsonl', [user('/work/blog', ago(2 * HOUR)), assistant('/work/blog', ago(2 * HOUR), 'msg-2', usage(88_000))], ago(2 * HOUR));
  write('-work-docs-site', 'cccc3333.jsonl', [
    assistant('/work/docs-site', ago(4 * HOUR), 'msg-3', usage(140_000)),
    guardStop('/work/docs-site', ago(MINUTE)),
  ], ago(MINUTE));
  write('-work-old', 'dddd4444.jsonl', [assistant('/work/old', ago(30 * HOUR), 'msg-4', usage(500_000))], ago(30 * HOUR));
  return dir;
}

const io = (dir: string) => ({ env: { CLAUDE_CONFIG_DIR: dir }, now: () => NOW });

describe('readStatus', () => {
  it('lists the sessions of the last hours, newest first, with their context and their cache', () => {
    const status = readStatus({}, io(claudeDir()));
    expect(status.sessions.map((session) => [session.project, session.context, session.cacheLive, session.guardWillStop])).toEqual([
      ['/work/shop-api', 312_000, true, false],
      ['/work/blog', 88_000, false, false],
      ['/work/docs-site', 140_000, false, true],
    ]);
    expect(status.sessions[0]!.cacheExpiresAt).toBe(new Date(NOW.getTime() + 40 * MINUTE).toISOString());
  });

  it('adds up the calls of today once each, subagents too, and the stops of the guard in sessions only', () => {
    const { today } = readStatus({}, io(claudeDir()));
    // shop-api once (two lines, one call), its subagent, blog, and docs-site from 4 hours ago. Not yesterday's call.
    expect(today.calls).toBe(4);
    expect(today.unpricedCalls).toBe(1);
    expect(today.guardStops).toBe(1);
    expect(today.tokens.cacheRead).toBe(312_000 + 20_000 + 88_000 + 140_000 - 4 * 1_002);
    // Each call: 2 + 2 × 1,000 written + 0.05 × read + 5 × 100 output, at $4 per million input tokens.
    const usd = [312_000, 88_000, 140_000].reduce((sum, context) => sum + ((2 + 2_000 + 0.05 * (context - 1_002) + 500) * 4) / 1e6, 0);
    expect(today.usd).toBeCloseTo(usd, 10);
  });

  it('keeps to the hours and the limit it is given', () => {
    expect(readStatus({ hours: '3' }, io(claudeDir())).sessions.map((session) => session.project)).toEqual(['/work/shop-api', '/work/blog', '/work/docs-site']);
    expect(readStatus({ hours: '1' }, io(claudeDir())).sessions.map((session) => session.project)).toEqual(['/work/shop-api', '/work/docs-site']);
    expect(readStatus({ limit: '1' }, io(claudeDir())).sessions).toHaveLength(1);
  });
});

describe('addToday', () => {
  it('prices each model at its own input price, with its own share for cache reads', () => {
    const today: TodayStatus = { since: '', calls: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, usd: 0, unpricedCalls: 0, guardStops: 0 };
    const calls = [
      assistant('/work/x', NOW, 'fable', usage(201_002), 'claude-fable-5-2'),
      assistant('/work/x', NOW, 'haiku', usage(201_002), 'claude-haiku-5-5'),
      assistant('/work/x', NOW, 'opus', usage(201_002), 'claude-opus-5-5'),
    ];
    addToday(today, calls.join('\n'), NOW.getTime() - HOUR, true, new Set());
    // 2 input + 2 × 1,000 written + share × 200,000 read + 5 × 100 output, at the input price of each model.
    const cost = (price: number, share: number): number => ((2 + 2_000 + share * 200_000 + 500) * price) / 1e6;
    expect(today.unpricedCalls).toBe(0);
    expect(today.usd).toBeCloseTo(cost(8, 0.025) + cost(0.1, 0.1) + cost(4, 0.05), 10);
  });
});

describe('readSince', () => {
  it('reads only the end of a long transcript that holds everything written since a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-since-'));
    const path = join(dir, 'long.jsonl');
    const old = Array.from({ length: 50 }, (_, index) => assistant('/work/x', ago(20 * HOUR - index * MINUTE), `old-${index}`, usage(1_000)));
    const today = Array.from({ length: 5 }, (_, index) => assistant('/work/x', ago(HOUR - index * MINUTE), `new-${index}`, usage(1_000)));
    writeFileSync(path, `${[...old, ...today].join('\n')}\n`);
    const text = readSince(path, ago(5 * HOUR).getTime(), 200);
    for (const line of today) expect(text).toContain(line);
    expect(text).not.toContain('"old-0"');
  });
});

describe('rendering', () => {
  const status = (): Status => readStatus({}, io(claudeDir()));
  const programs = { node: '/usr/local/bin/node', bin: '/opt/arricurdai/dist/bin.js' };

  it('prints a table of the sessions and a line on today', () => {
    const text = renderStatus(status());
    expect(text).toContain('shop-api    312,000 tokens   cache expires in 40m');
    expect(text).toContain('docs-site   140,000 tokens   cache expired 3h 0m ago: the guard stops the next prompt');
    expect(text).toContain('Today: about $0.14 at API prices over 4 calls (1 of models with no known price left out), 1 stop of the guard.');
  });

  it('counts down in the menu bar to the large session whose cache expires first, with a menu of every session', () => {
    const menu = renderSwiftBar(status(), programs);
    const lines = menu.split('\n');
    expect(lines[0]).toMatch(/^312k · 40m \| templateImage=[A-Za-z0-9+/=]+$/);
    expect(lines).toContain('shop-api · 312k · cache expires in 40m');
    expect(lines).toContain('--Profile this project in Terminal | bash="/usr/local/bin/node" param1="/opt/arricurdai/dist/bin.js" param2=profile param3=--project param4="/work/shop-api" terminal=true');
    expect(lines).toContain('docs-site · 140k · cache expired 3h 0m ago · guard | color=gray');
    expect(lines).toContain('blog · 88k · cache expired 1h 0m ago | color=gray');
    expect(lines).toContain('Guard stops today: 1');
    expect(lines).toContain('Refresh | refresh=true');
  });

  it('turns the title and the session orange in the last ten minutes, and shows the icon alone when no large cache lives', () => {
    const late = readStatus({}, { ...io(claudeDir()), now: () => new Date(NOW.getTime() + 35 * MINUTE) });
    const lines = renderSwiftBar(late, programs).split('\n');
    expect(lines[0]).toMatch(/^312k · 5m \| templateImage=\S+ color=#d97706$/);
    expect(lines).toContain('shop-api · 312k · cache expires in 5m | color=#d97706');
    const none = readStatus({ minTokens: '400000' }, io(claudeDir()));
    expect(renderSwiftBar(none, programs).split('\n')[0]).toMatch(/^ \| templateImage=\S+$/);
  });

  it('keeps a | in a folder name from breaking the menu, and never prints the text of a session', async () => {
    const dir = claudeDir();
    mkdirSync(join(dir, 'projects', '-work-a-b'));
    writeFileSync(join(dir, 'projects', '-work-a-b', 'eeee5555.jsonl'), `${assistant('/work/a|b', ago(MINUTE), 'msg-5', usage(150_000))}\n`);
    utimesSync(join(dir, 'projects', '-work-a-b', 'eeee5555.jsonl'), ago(MINUTE), ago(MINUTE));
    const out: string[] = [];
    const run = (options: object) =>
      runStatus(options, { ...io(dir), cwd: '/', stdout: (text) => out.push(text), stderr: (text) => out.push(text), colors: false, ...programs });
    expect(await run({})).toBe(0);
    expect(await run({ json: true })).toBe(0);
    expect(await run({ swiftbar: true })).toBe(0);
    expect(out.join('')).not.toContain(SECRET);
    expect(out[2]).toContain('\na b · 150k · cache expires in 59m\n');
  });

  it('says what is wrong with an option', async () => {
    const out: string[] = [];
    const io2 = { ...io(claudeDir()), cwd: '/', stdout: (text: string) => out.push(text), stderr: (text: string) => out.push(text), colors: false, ...programs };
    expect(await runStatus({ hours: 'two' }, io2)).toBe(1);
    expect(await runStatus({ json: true, swiftbar: true }, io2)).toBe(1);
    expect(out).toEqual(['arricurdai: --hours must be a whole number of 1 or more, got "two"\n', 'arricurdai: choose one of --json and --swiftbar\n']);
  });
});
