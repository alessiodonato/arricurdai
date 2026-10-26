import { describe, expect, test } from 'vitest';
import { SPEC_PARAMS } from './spec-params';
import { simulateContext, simulateSession, type Usage } from '../src/index';
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
