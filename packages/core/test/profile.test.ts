import { describe, expect, test } from 'vitest';
import { SPEC_PARAMS } from './spec-params';
import { profile, reportSchema, type ProfileInput, type ProfileSession } from '../src/index';
import { call, calls, context, read, session } from './helpers';

const stats = { lines: 10, empty: 1, malformedJson: 2, notObject: 1, ignored: 3, unknownTypes: { future: 1 }, invalid: { user: 1 }, orphanResults: 0 };
const input = (sessions: ProfileSession[], duplicateCalls = 0): ProfileInput => ({ dir: '/t', sessions, stats, duplicateCalls });
const options = { projectRoot: '/repo', generatedAt: '2026-10-26T00:00:00.000Z', params: SPEC_PARAMS };

// Two sessions of 10 calls: the second reads src/a.ts again, unchanged.
const oneCall = call({ input: 1000, cacheWrite: 1000, cacheWrite1h: 1000, cacheRead: 8000, output: 100 });
const sessionWith = (id: string, day: string, extra: Partial<ProfileSession> = {}) =>
  session(id, `2026-09-0${day}T10:00:00.000Z`, {
    main: context({ calls: [oneCall, ...calls(9)], reads: [read('file:src/a.ts', { timestamp: `2026-09-0${day}T10:01:00.000Z`, turn: 3 })] }),
    ...extra,
  });

describe('profile', () => {
  test('measures cost, rediscovery and S_max, and returns a valid report', () => {
    const report = profile(input([sessionWith('s1', '1'), sessionWith('s2', '2')]), { ...options, changedBetween: () => false });
    expect(reportSchema.safeParse(report).success).toBe(true);
    // K per session: 1000 + 2 · 1000 + 0.1 · 8000 + 5 · 100 = 4300
    expect(report.sessions.map((s) => [s.sessionId, s.cost, s.rediscoveries])).toEqual([['s1', 4300, 0], ['s2', 4300, 1]]);
    // rent of 100 tokens entered at turn 3 of 10: 100 · (2 + 0.1 · 7) = 270; S_max = 270 / 8600
    expect(report.summary.rediscoveryCost).toBeCloseTo(270, 9);
    expect(report.summary.maxSavings).toBeCloseTo(270 / 8600, 12);
    expect(report.summary.rediscoveryShare).toBeCloseTo(0.5, 12);
    expect(report.summary.cacheReadShare).toBeCloseTo(8000 / 10000, 12);
    expect(report.rediscoveries).toEqual([{ key: 'file:src/a.ts', kind: 'file', target: 'src/a.ts', count: 1, tokens: 100, cost: expect.closeTo(270, 9) }]);
    expect(report.approximations).toEqual([]);
  });

  test('measures only the latest sessions, and uses the older ones as history', () => {
    const report = profile(input([sessionWith('s1', '1'), sessionWith('s2', '2'), sessionWith('s3', '3')]), { ...options, sessions: 1, changedBetween: () => false });
    expect(report.window).toMatchObject({ sessions: 1, available: 3, from: '2026-09-03T10:00:00.000Z' });
    expect(report.sessions.map((s) => [s.sessionId, s.rediscoveries])).toEqual([['s3', 1]]);
  });

  test('adds the usage that only the session totals record, such as a compaction', () => {
    const compacted = sessionWith('s1', '1', { unrecordedUsage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 10 } });
    // 4300 + 100 + 5 · 10
    expect(profile(input([compacted]), options).sessions[0]?.cost).toBe(4450);
  });

  test('says what is approximate', () => {
    const noMemory = sessionWith('s2', '2', { recordsMemory: false });
    const report = profile(input([sessionWith('s1', '1'), noMemory], 3), {
      ...options,
      diskMemory: [{ path: '/repo/CLAUDE.md', type: 'Project', content: '- Use `pnpm test`.' }],
    });
    expect(report.approximations).toEqual([
      'The project has no git history, so only the file changes made through Claude Code are seen. A file edited outside it can count as a rediscovery.',
      '1 session does not record which memory files it loaded. Its memory was rebuilt from the files on disk today.',
      '3 API calls appear in more than one session, for example after a fork. Their cost may be counted twice.',
    ]);
    expect(report.memory.files.map((f) => [f.path, f.sessions])).toEqual([['CLAUDE.md', 1]]);
    expect(report.memory.unusedLines.map((l) => l.text)).toEqual(['Use `pnpm test`.']);
  });

  test('counts rediscoveries git could not check', () => {
    const report = profile(input([sessionWith('s1', '1'), sessionWith('s2', '2')]), { ...options, changedBetween: () => undefined });
    expect(report.approximations).toEqual(['1 rediscovered file could not be checked against git, because it is outside the repository.']);
  });

  test('reports the lines the parser could not use', () => {
    expect(profile(input([]), options).lines).toEqual({ total: 10, malformed: 3, unknownTypes: { future: 1 }, invalid: { user: 1 }, orphanResults: 0 });
  });

  test('works with no sessions at all', () => {
    const report = profile(input([]), options);
    expect(report.summary).toMatchObject({ sessions: 0, meanCost: 0, maxSavings: 0, rediscoveryShare: 0 });
    expect(reportSchema.safeParse(report).success).toBe(true);
  });
});
