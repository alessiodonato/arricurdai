import { describe, expect, test } from 'vitest';
import { DEFAULT_COST_PARAMS, judgeReads, turnsInContext } from '../src/index';
import { calls, context, read, session } from './helpers';

const params = DEFAULT_COST_PARAMS;
const DAY1 = '2026-09-01T10:00:00.000Z';
const DAY2 = '2026-09-02T10:00:00.000Z';

describe('turnsInContext', () => {
  test('counts the turns up to the last call', () => {
    expect(turnsInContext({ calls: calls(10), compactions: [] }, 3)).toBe(7);
  });

  test('stops at the next compaction, which drops the block', () => {
    expect(turnsInContext({ calls: calls(10), compactions: [5] }, 3)).toBe(2);
    expect(turnsInContext({ calls: calls(10), compactions: [2, 6] }, 3)).toBe(3);
    expect(turnsInContext({ calls: calls(10), compactions: [5] }, 7)).toBe(3);
    expect(turnsInContext({ calls: calls(10), compactions: [5] }, 5)).toBe(0);
  });
});

describe('judgeReads', () => {
  const first = (reads = [read('file:src/a.ts', { timestamp: '2026-09-01T10:01:00.000Z' })]) =>
    session('s1', DAY1, { main: context({ reads }) });
  const second = (reads = [read('file:src/a.ts', { timestamp: '2026-09-02T10:01:00.000Z', turn: 3 })], extra = {}) =>
    session('s2', DAY2, { main: context({ reads }), ...extra });

  test('a file read again in a later session, unchanged, is a rediscovery that pays rent', () => {
    const verdicts = judgeReads([first(), second()], params, () => false);
    expect(verdicts.map((v) => [v.sessionId, v.rediscovery, v.unchecked])).toEqual([['s1', false, false], ['s2', true, false]]);
    // 100 tokens entered at turn 3 of 10, 1-hour cache: 100 · (2 + 0.1 · 7)
    expect(verdicts[1]?.cost).toBeCloseTo(270, 9);
  });

  test('a file changed through Claude Code in between is not a rediscovery', () => {
    const changed = second(undefined, { fileChanges: [{ path: 'src/a.ts', timestamp: '2026-09-02T10:00:30.000Z' }] });
    expect(judgeReads([first(), changed], params, () => false)[1]?.rediscovery).toBe(false);
  });

  test('a change before the first read or after the second does not count', () => {
    const early = session('s0', '2026-08-31T10:00:00.000Z', { fileChanges: [{ path: 'src/a.ts', timestamp: '2026-08-31T10:00:00.000Z' }] });
    const late = second(undefined, { fileChanges: [{ path: 'src/a.ts', timestamp: '2026-09-02T11:00:00.000Z' }] });
    expect(judgeReads([early, first(), late], params, () => false).at(-1)?.rediscovery).toBe(true);
  });

  test('a file changed in git in between is not a rediscovery', () => {
    const asked: string[][] = [];
    const verdicts = judgeReads([first(), second()], params, (path, since, until) => {
      asked.push([path, since, until]);
      return true;
    });
    expect(verdicts[1]?.rediscovery).toBe(false);
    expect(asked).toEqual([['src/a.ts', '2026-09-01T10:01:00.000Z', '2026-09-02T10:01:00.000Z']]);
  });

  test('without an answer from git, a rediscovery counts but is marked unchecked', () => {
    expect(judgeReads([first(), second()], params, () => undefined)[1]).toMatchObject({ rediscovery: true, unchecked: true });
    expect(judgeReads([first(), second()], params)[1]).toMatchObject({ rediscovery: true, unchecked: true });
  });

  test('a search is a rediscovery only when its result is identical', () => {
    const search = (hash: string, timestamp: string) => [read('search:TODO @ src', { resultHash: hash, timestamp })];
    expect(judgeReads([first(search('h1', DAY1)), second(search('h1', DAY2))], params)[1]?.rediscovery).toBe(true);
    expect(judgeReads([first(search('h1', DAY1)), second(search('h2', DAY2))], params)[1]?.rediscovery).toBe(false);
  });

  test('reading the same file twice in one session is not a rediscovery', () => {
    const twice = [read('file:src/a.ts', { turn: 2 }), read('file:src/a.ts', { turn: 5 })];
    expect(judgeReads([session('s1', DAY1, { main: context({ reads: twice }) })], params).map((v) => v.rediscovery)).toEqual([false, false]);
  });

  test('failed reads and results that never reached the model are ignored', () => {
    const failed = first([read('file:src/a.ts', { isError: true }), read('file:src/b.ts', { turn: undefined })]);
    const again = second([read('file:src/a.ts', { turn: 3 }), read('file:src/b.ts', { turn: 3 })]);
    const verdicts = judgeReads([failed, again], params);
    expect(verdicts.map((v) => [v.sessionId, v.read.key, v.rediscovery])).toEqual([['s2', 'file:src/a.ts', false], ['s2', 'file:src/b.ts', false]]);
  });

  test('reads of a subagent are judged in its own context, with its cache TTL', () => {
    const sub = context({ kind: 'subagent', calls: calls(4), cacheTtl: '5m', reads: [read('file:src/a.ts', { turn: 2, timestamp: DAY2 })] });
    const verdicts = judgeReads([first(), session('s2', DAY2, { subagents: [sub] })], params, () => false);
    // 100 · (1.25 + 0.1 · (4 − 2))
    expect(verdicts[1]?.cost).toBeCloseTo(145, 9);
  });

  test('sessions are judged in order of start, whatever order they come in', () => {
    expect(judgeReads([second(), first()], params, () => false).map((v) => [v.sessionId, v.rediscovery])).toEqual([['s1', false], ['s2', true]]);
  });
});
