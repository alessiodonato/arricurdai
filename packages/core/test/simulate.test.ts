import { describe, expect, test } from 'vitest';
import { SPEC_PARAMS } from './spec-params';
import { replayContext, replaySession, simulateContext, simulateSession, type Usage } from '../src/index';
import { context, session } from './helpers';

const params = SPEC_PARAMS; // w1h = 2, r = 0.1, mu = 5
const call = (cacheWrite: number, cacheRead: number): { usage: Usage } => ({
  usage: { input: 0, cacheWrite, cacheWrite5m: 0, cacheWrite1h: cacheWrite, cacheRead, output: 0 },
});
// A compaction keeps a prefix of 5,000 tokens and writes a summary of 1,000.
const sizes = { prefixTokens: 5000, summaryTokens: 1000 };

describe('simulateContext', () => {
  // Requests of 10,000, 12,000, 12,500 and 13,000 tokens. Call 3 comes after a pause: it reads
  // nothing from the cache and writes the 12,000 tokens of call 2 again.
  const paused = context({ calls: [call(10000, 0), call(2000, 10000), call(12500, 0), call(500, 12500)] });
  // Measured: 2·10000; 2·2000 + 0.1·10000; 2·12500; 2·500 + 0.1·12500
  const measured = 20000 + 5000 + 25000 + 2250;

  test('changes nothing when the policy never compacts', () => {
    expect(simulateContext(paused, params, { kind: 'cap', cap: 1_000_000 }, sizes)).toEqual({ measured, simulated: measured, compactions: 0 });
  });

  test('compacting before the pause reads the warm context once and shrinks what follows', () => {
    // Compaction: 0.1 · 12,000 read + 5 · 1,000 written; 12,000 − 6,000 = 6,000 tokens removed.
    // Call 3 writes 12,500 − 6,000 = 6,500 tokens: 2 · 6,500. Call 4 reads 12,500 − 6,000: 2 · 500 + 0.1 · 6,500.
    const result = simulateContext(paused, params, { kind: 'before-rebuild' }, sizes);
    expect(result.compactions).toBe(1);
    expect(result.simulated).toBeCloseTo(20000 + 5000 + 6200 + 13000 + 1650, 9);
    expect(result.measured - result.simulated).toBeCloseTo(6400, 9);
  });

  test('compacting when coming back reads the cold context at the write price', () => {
    // Compaction: 2 · 12,000 + 5 · 1,000. The rest as above: here it costs more than it saves.
    const result = simulateContext(paused, params, { kind: 'after-rebuild' }, sizes);
    expect(result.simulated).toBeCloseTo(20000 + 5000 + 29000 + 13000 + 1650, 9);
    expect(result.measured - result.simulated).toBeCloseTo(-16400, 9);
  });

  test('a cap compacts before a request would pass it, and can cost more than it saves', () => {
    // Requests of 10,000, 30,000, 50,000 and 51,000 tokens, cap 40,000: compaction before call 3.
    const growing = context({ calls: [call(10000, 0), call(20000, 10000), call(20000, 30000), call(1000, 50000)] });
    const result = simulateContext(growing, params, { kind: 'cap', cap: 40000 }, sizes);
    // Measured: 20,000 + 41,000 + 43,000 + 7,000.
    // Compaction: 0.1 · 30,000 + 5 · 1,000, and the summary written at call 3 instead of read: 1.9 · 1,000.
    // Call 3: 2 · 20,000 + 0.1 · (30,000 − 24,000). Call 4: 2 · 1,000 + 0.1 · (50,000 − 24,000).
    expect(result.compactions).toBe(1);
    expect(result.measured).toBeCloseTo(111000, 9);
    expect(result.simulated).toBeCloseTo(20000 + 41000 + 8000 + 1900 + 40600 + 4600, 9);
  });

  test('a real compaction resets what the simulation removed', () => {
    const compacted = context({ calls: [call(10000, 0), call(12500, 0), call(3000, 0), call(500, 3000)], compactions: [2] });
    const result = simulateContext(compacted, params, { kind: 'before-rebuild' }, sizes);
    // Call 2 is a rebuild and gets a compaction; call 3 starts a new stretch, so calls 3 and 4 cost what they cost.
    expect(result.compactions).toBe(1);
    expect(result.simulated).toBeCloseTo(20000 + (0.1 * 10000 + 5000) + 2 * 8500 + 6000 + (1000 + 300), 9);
  });
});

describe('simulateSession', () => {
  test('adds the calls only cost-state records, as they were', () => {
    const paused = context({ calls: [call(10000, 0), call(2000, 10000), call(12500, 0), call(500, 12500)] });
    const withCompaction = session('s1', '2026-09-01T10:00:00.000Z', { main: paused, unrecordedUsage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 0 } });
    const result = simulateSession(withCompaction, params, { kind: 'before-rebuild' }, () => sizes);
    expect(result.measured - result.simulated).toBeCloseTo(6400, 9);
    expect(result.measured).toBeCloseTo(52250 + 100, 9);
  });
});

describe('replayContext', () => {
  // Requests of 10,000, 12,000, 4,000 and 4,500 tokens, with a compaction after call 2.
  // Measured: 2·10000; 2·2000 + 0.1·10000; 2·3000 + 0.1·1000; 2·500 + 0.1·4000 = 32,500.
  const compacted = (auto: boolean) =>
    context({
      calls: [call(10000, 0), call(2000, 10000), call(3000, 1000), call(500, 4000)],
      compactions: [2],
      autoCompactions: auto ? [2] : [],
    });
  const measured = 32500;

  test('leaves out an automatic compaction under the window: what it dropped stays, and every later call reads it', () => {
    // Calls 1 and 2 as they were: 25,000. Call 3 reads the 12,000 tokens of call 2: 1,200.
    // Call 4 reads 4,000 + the 8,000 kept, and writes its 500: 1,200 + 1,000.
    expect(replayContext(compacted(true), params, { window: 1_000_000 }, sizes)).toEqual({
      simulated: 25000 + 1200 + 2200,
      compactions: 0,
      skipped: 1,
      finalSize: 12500,
    });
  });

  test('keeps a compaction the user asked for, and a rewind', () => {
    expect(replayContext(compacted(false), params, { window: 1_000_000 }, sizes)).toEqual({
      simulated: measured,
      compactions: 0,
      skipped: 0,
      finalSize: 4500,
    });
  });

  test('compacts when the context goes over the window', () => {
    // Call 3 goes on at 12,000. Call 4 would be 12,500, over the window: the compaction reads 12,000
    // (1,200), writes the summary (5,000) and the next call writes it to the cache (1.9 · 1,000).
    // 6,000 kept instead of 4,000: call 4 reads 4,000 + 2,000 and writes 500.
    const result = replayContext(compacted(true), params, { window: 12_400 }, sizes);
    expect(result.compactions).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.simulated).toBeCloseTo(25000 + 1200 + 8100 + 1600, 9);
    expect(result.finalSize).toBe(6500);
  });

  test('a session that goes on from an earlier one writes what it carries, and reads it afterwards', () => {
    const fresh = context({ calls: [call(10000, 0), call(2000, 10000)] });
    // Call 1 writes its 10,000 and the 20,000 carried: 2 · 30,000. Call 2 reads them: 0.1 · 30,000 + 2 · 2,000.
    expect(replayContext(fresh, params, { window: 1_000_000, carried: 20_000 }, sizes)).toEqual({
      simulated: 60000 + 3000 + 4000,
      compactions: 0,
      skipped: 0,
      finalSize: 32000,
    });
  });

  test('after a pause the tokens carried are written again, not read', () => {
    const paused = context({ calls: [call(10000, 0), call(2000, 10000), call(12500, 0), call(500, 12500)] });
    // 2 · 15,000; 2 · 2,000 + 0.1 · 15,000; 2 · 17,500; 2 · 500 + 0.1 · 17,500.
    const { simulated } = replayContext(paused, params, { window: 1_000_000, carried: 5000 }, sizes);
    expect(simulated).toBeCloseTo(30000 + 5500 + 35000 + 2750, 9);
  });

  test('with the same limit and nothing carried, the replay is the session as it ran', () => {
    expect(replayContext(compacted(true), params, { window: 12_000, keepsLimit: true }, sizes)).toEqual({
      simulated: measured,
      compactions: 0,
      skipped: 0,
      finalSize: 4500,
    });
  });

  test('with the same limit, a context that carries tokens compacts sooner, at the cost measured', () => {
    const fresh = context({ calls: [call(10000, 0), call(2000, 10000), call(3000, 12000)] });
    // Call 1 writes 15,000. Call 2 would be 17,000: the compaction costs 1,000, and writing the
    // summary 1.9 · 1,000. 6,000 stay instead of 10,000, so call 2 reads 6,000 and writes 2,000.
    // Call 3 reads 8,000 and writes 3,000.
    const options = { window: 16_000, keepsLimit: true, carried: 5000, compactionCost: 1000 };
    expect(replayContext(fresh, params, options, sizes)).toEqual({
      simulated: 30000 + 2900 + 4600 + 6800,
      compactions: 1,
      skipped: 0,
      finalSize: 11000,
    });
  });

  test('with the same limit, a real compaction is left out when the replay is under it', () => {
    // Call 2 compacts as above, at the cost of the formula: 0.1 · 15,000 + 5 · 1,000 + 1.9 · 1,000.
    // At call 3 the replay stands at 8,000, under the limit: it goes on, and carries 4,000 from there.
    const result = replayContext(compacted(true), params, { window: 14_000, keepsLimit: true, carried: 5000 }, sizes);
    expect(result).toMatchObject({ compactions: 1, skipped: 1, finalSize: 8500 });
    expect(result.simulated).toBeCloseTo(30000 + 8400 + 4600 + 800 + 1800, 9);
  });

  test('changes nothing when there is nothing to replay', () => {
    const plain = context({ calls: [call(10000, 0), call(2000, 10000)] });
    expect(replayContext(plain, params, { window: 1_000_000 }, sizes).simulated).toBe(25000);
  });
});

describe('replaySession', () => {
  const main = context({
    calls: [call(10000, 0), call(2000, 10000), call(3000, 1000), call(500, 4000)],
    compactions: [2],
    autoCompactions: [2],
  });
  const compactionCall = { input: 0, cacheWrite: 0, cacheRead: 0, output: 400 };

  test('counts the subagents as they ran, and drops the cost of the compactions left out', () => {
    const helper = context({ kind: 'subagent', calls: [call(1000, 0)] });
    const result = replaySession(session('a', '2026-10-01T00:00:00Z', { main, subagents: [helper], unrecordedUsage: compactionCall }), params, { window: 1_000_000 }, () => sizes);
    expect(result.simulated).toBeCloseTo(28400 + 2000, 9);
  });

  test('keeps the cost of a compaction that still happens', () => {
    const keep = context({ ...main, autoCompactions: [] });
    const result = replaySession(session('a', '2026-10-01T00:00:00Z', { main: keep, unrecordedUsage: compactionCall }), params, { window: 1_000_000 }, () => sizes);
    expect(result.simulated).toBeCloseTo(32500 + 2000, 9);
  });
});
