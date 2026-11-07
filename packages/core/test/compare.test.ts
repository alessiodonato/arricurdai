import { describe, expect, test } from 'vitest';
import { comparePeriods, RECALL_LABEL, type SessionBlock, type Usage } from '../src/index';
import { context, read, session } from './helpers';
import { SPEC_PARAMS } from './spec-params';

const params = SPEC_PARAMS; // w1h = 2, r = 0.1, mu = 5
const call = (cacheWrite: number, cacheRead: number): { usage: Usage } => ({
  usage: { input: 0, cacheWrite, cacheWrite5m: 0, cacheWrite1h: cacheWrite, cacheRead, output: 0 },
});
const prompt = (turn: number): SessionBlock => ({ kind: 'prompt', group: 'prompt', label: 'Prompt', tokens: 10, turn });
const SINCE = '2026-10-10T00:00:00Z';

// Before the date: a long session that grew to 90,000 tokens, with two prompts.
const longBefore = session('before', '2026-10-01T09:00:00Z', {
  main: context({ calls: [call(10000, 0), call(80000, 10000)], blocks: [prompt(1), prompt(2)] }),
});
// After the date: compacted automatically at 12,000, with one prompt.
const compactedAfter = session('after', '2026-10-11T09:00:00Z', {
  main: context({
    calls: [call(10000, 0), call(2000, 10000), call(3000, 1000), call(500, 4000)],
    compactions: [2],
    autoCompactions: [2],
    blocks: [prompt(1)],
  }),
});

describe('comparePeriods', () => {
  test('splits the sessions by when they started and measures each period', () => {
    const result = comparePeriods([compactedAfter, longBefore], { since: SINCE, params });
    expect(result.before).toMatchObject({ sessions: 1, calls: 2, prompts: 2, averageContext: 50000, largestContext: 90000, autoCompactions: 0, manualCompactions: 0 });
    expect(result.before.cost).toBeCloseTo(20000 + 160000 + 1000, 9);
    expect(result.after).toMatchObject({ sessions: 1, calls: 4, prompts: 1, averageContext: 7625, largestContext: 12000, autoCompactions: 1, manualCompactions: 0 });
    expect(result.after.cost).toBeCloseTo(32500, 9);
  });

  test('leaves out sessions after --until and sessions with no date', () => {
    const late = session('late', '2026-10-20T09:00:00Z');
    const undated = session('undated', '', { startedAt: undefined });
    const result = comparePeriods([longBefore, compactedAfter, late, undated], { since: SINCE, until: '2026-10-15T00:00:00Z', params });
    expect([result.before.sessions, result.after.sessions, result.undated]).toEqual([1, 1, 1]);
  });

  test('finds the limit in the automatic compactions and replays them up to the largest request', () => {
    const result = comparePeriods([longBefore, compactedAfter], { since: SINCE, params });
    expect(result.limit).toBe(12000);
    expect(result.window).toBe(90000);
    expect(result.withoutLimit).toEqual({ cost: 28400, compactions: 0, skipped: 1 });
  });

  test('takes the window from the option', () => {
    expect(comparePeriods([longBefore, compactedAfter], { since: SINCE, params, window: 500_000 }).window).toBe(500_000);
  });

  test('with no change the replay is the sessions as they ran, compactions included', () => {
    const paid = { ...compactedAfter, unrecordedUsage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 400 } };
    const result = comparePeriods([longBefore, paid], { since: SINCE, params });
    expect(result.after.cost).toBeCloseTo(32500 + 2000, 9);
    expect(result.withoutGuard).toEqual({ cost: result.after.cost, compactions: 0, skipped: 0 });
  });

  test('when no earlier session went past the limit, the limit changed nothing', () => {
    const small = session('small', '2026-10-01T09:00:00Z', { main: context({ calls: [call(5000, 0)] }) });
    const result = comparePeriods([small, compactedAfter], { since: SINCE, params });
    expect(result.window).toBe(12000);
    expect(result.withoutLimit).toEqual({ cost: result.after.cost, compactions: 0, skipped: 0 });
  });

  test('a replay compacts at the size and the cost of the real compactions', () => {
    const real = {
      ...compactedAfter,
      guardStops: 1,
      unrecordedUsage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 400 },
    };
    const next = session('next', '2026-10-11T12:00:00Z', {
      startedFromNote: true,
      main: context({ calls: [call(1000, 0), call(4000, 1000), call(8000, 5000)] }),
    });
    const { withoutGuard } = comparePeriods([longBefore, real, next], { since: SINCE, params });
    // The real compaction left 4,000 tokens, 3,000 of them written, and cost 2,000. `next` carries
    // 4,500 − 1,000. Call 1 writes 4,500. Call 2 reads them and writes 4,000. Call 3 would be 16,500,
    // over the limit of 12,000: 2,000 + 1.9 · 3,000 to compact, then it reads 4,000 and writes 8,000.
    expect(withoutGuard.compactions).toBe(1);
    expect(withoutGuard.cost).toBeCloseTo(34500 + 9000 + 8450 + 7700 + 16400, 9);
  });

  test('with no automatic compaction there is no limit to take away', () => {
    const plain = session('plain', '2026-10-11T09:00:00Z', { main: context({ calls: [call(10000, 0), call(2000, 10000)] }) });
    const result = comparePeriods([longBefore, plain], { since: SINCE, params });
    expect(result.limit).toBeUndefined();
    expect(result.withoutLimit.cost).toBeCloseTo(result.after.cost, 9);
  });

  // The guard stopped the first session at 60,000 tokens, and the second started from the note.
  const stopped = session('stopped', '2026-10-11T09:00:00Z', {
    guardStops: 1,
    main: context({ calls: [call(50000, 0), call(10000, 50000)] }),
  });
  const fromNote = session('from-note', '2026-10-11T12:00:00Z', {
    startedFromNote: true,
    main: context({ calls: [call(5000, 0), call(1000, 5000)] }),
  });

  test('without the guard, a session started from the note goes on from the one stopped', () => {
    const result = comparePeriods([longBefore, stopped, fromNote], { since: SINCE, params });
    const measured = 100000 + 20000 + 5000 + 10000 + 2000 + 500;
    expect(result.after.cost).toBeCloseTo(measured, 9);
    expect(result.chained).toBe(1);
    // It carries 60,000 − 5,000: its first call writes 60,000 and the second reads them.
    expect(result.withoutGuard.cost).toBeCloseTo(100000 + 20000 + 5000 + 120000 + 2000 + 6000, 9);
    expect(result.withoutBoth.cost).toBeCloseTo(result.withoutGuard.cost, 9);
    expect(result.withoutLimit.cost).toBeCloseTo(measured, 9);
  });

  test('a chain goes on through the size the earlier session reached in the replay', () => {
    const next = session('next', '2026-10-11T15:00:00Z', {
      startedFromNote: true,
      guardStops: 0,
      main: context({ calls: [call(5000, 0)] }),
    });
    const stoppedAgain = { ...fromNote, guardStops: 1 };
    const result = comparePeriods([longBefore, stopped, stoppedAgain, next], { since: SINCE, params });
    expect(result.chained).toBe(2);
    // fromNote ended at 61,000 in the replay, so next carries 56,000 and writes 61,000.
    expect(result.withoutGuard.cost).toBeCloseTo(100000 + 20000 + 5000 + 120000 + 2000 + 6000 + 122000, 9);
  });

  test('a note with no stopped session before it starts no chain', () => {
    const result = comparePeriods([longBefore, fromNote], { since: SINCE, params });
    expect(result.chained).toBe(0);
    expect(result.withoutGuard.cost).toBeCloseTo(result.after.cost, 9);
  });

  test('counts the stops, the notes and the searches, and what they cost', () => {
    const blocks: SessionBlock[] = [
      { kind: 'injected', group: 'hook_additional_context', label: 'Claude Code: hook_additional_context', tokens: 1000, turn: 1 },
      { kind: 'tool', group: 'Bash', label: RECALL_LABEL, tokens: 1000, turn: 2 },
    ];
    const worked = session('worked', '2026-10-11T09:00:00Z', {
      guardStops: 2,
      startedFromNote: true,
      main: context({ calls: [call(10000, 0), call(2000, 10000), call(1000, 12000)], blocks }),
    });
    const { after } = comparePeriods([longBefore, worked], { since: SINCE, params });
    expect(after).toMatchObject({ guardStops: 2, notes: 1, recallSearches: 1 });
    expect(after.handoffCost).toBeGreaterThan(0);
    // The search takes a call of its own: 2 · 2,000 + 0.1 · 10,000, plus the rent of its result.
    expect(after.recallCost).toBeGreaterThan(5000);
  });

  test('counts what reading again what an earlier session had read cost', () => {
    const first = session('first', '2026-10-01T09:00:00Z', { main: context({ calls: [call(10000, 0), call(1000, 10000)], reads: [read('file:a.ts', { turn: 2 })] }) });
    const again = session('again', '2026-10-11T09:00:00Z', { main: context({ calls: [call(10000, 0), call(1000, 10000)], reads: [read('file:a.ts', { turn: 2 })] }) });
    const { before, after } = comparePeriods([first, again], { since: SINCE, params });
    expect(before.rereadCost).toBe(0);
    expect(after.rereadCost).toBeGreaterThan(0);
  });
});
