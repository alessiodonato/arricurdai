import { describe, expect, test } from 'vitest';
import {
  DEFAULT_COST_PARAMS,
  loadNowThreshold,
  maxSavings,
  memoryRent,
  rent,
  sessionCost,
  shouldLoadNow,
  sumUsage,
  weightedCost,
  type Usage,
} from '../src/index';

// Every expected value is computed by hand in the comment next to it,
// with the default parameters w = 1.25, w1h = 2, r = 0.1, mu = 5, overhead = 300.

describe('values required by the phase 1 spec', () => {
  test('rent of 500 tokens with T − t = 50 is 3,125', () => {
    // 500 · (1.25 + 0.1 · 50) = 500 · 6.25
    expect(rent(500, 50)).toBeCloseTo(3125, 9);
  });

  test('rent of 20,000 tokens with T − t = 30 is 85,000', () => {
    // 20000 · (1.25 + 0.1 · 30) = 20000 · 4.25
    expect(rent(20000, 30)).toBeCloseTo(85000, 9);
  });

  test('load-now threshold with L = 60,000, overhead = 300, p = 0.5, T − t = 20 is about 1,938', () => {
    // 0.5 · (0.1 · 60000 + 300) / (0.5 · (1.25 + 0.1 · 20)) = 3150 / 1.625 = 1938.46…
    expect(loadNowThreshold({ contextTokens: 60000, probability: 0.5, turnsAfter: 20 })).toBeCloseTo(1938.4615, 4);
  });
});

describe('weightedCost: K = in + w·cw + r·cr + mu·out', () => {
  const call: Usage = { input: 2, cacheWrite: 5741, cacheRead: 8380, output: 509 };

  test('uses w for cache writes when the usage has no TTL split', () => {
    // 2 + 1.25 · 5741 + 0.1 · 8380 + 5 · 509 = 2 + 7176.25 + 838 + 2545
    expect(weightedCost(call)).toBeCloseTo(10561.25, 9);
  });

  test('prices writes to the 1-hour cache at w1h', () => {
    // 2 + 2 · 5741 + 0.1 · 8380 + 5 · 509 = 2 + 11482 + 838 + 2545
    expect(weightedCost({ ...call, cacheWrite5m: 0, cacheWrite1h: 5741 })).toBeCloseTo(14867, 9);
  });

  test('prices each part of a split write at its own TTL', () => {
    // 1.25 · 400 + 2 · 600
    expect(weightedCost({ input: 0, cacheWrite: 1000, cacheWrite5m: 400, cacheWrite1h: 600, cacheRead: 0, output: 0 })).toBeCloseTo(1700, 9);
  });

  test('prices the part of the writes that the split does not cover at w', () => {
    // 1.25 · (1000 − 600) + 2 · 600
    expect(weightedCost({ input: 0, cacheWrite: 1000, cacheWrite1h: 600, cacheRead: 0, output: 0 })).toBeCloseTo(1700, 9);
  });

  test('is the spec formula when w1h = w', () => {
    const params = { ...DEFAULT_COST_PARAMS, w1h: DEFAULT_COST_PARAMS.w };
    expect(weightedCost({ ...call, cacheWrite5m: 0, cacheWrite1h: 5741 }, params)).toBeCloseTo(10561.25, 9);
  });

  test('ignores fields that are not counts', () => {
    const withModel = { ...call, model: 'claude-sonnet-5-5' };
    expect(weightedCost(withModel)).toBeCloseTo(10561.25, 9);
  });

  test('rejects negative or non-finite counts', () => {
    expect(() => weightedCost({ ...call, cacheRead: -1 })).toThrow(RangeError);
    expect(() => weightedCost({ ...call, output: Number.NaN })).toThrow(RangeError);
    expect(() => weightedCost({ ...call, cacheWrite1h: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe('sessionCost: K_s over the API calls of a session', () => {
  // The seven calls of session A in fixtures/acme-shop, all writing to the 1-hour cache.
  const sessionA: Usage[] = [
    { input: 3, cacheWrite: 12000, cacheWrite1h: 12000, cacheRead: 0, output: 180 },
    { input: 1, cacheWrite: 1500, cacheWrite1h: 1500, cacheRead: 12000, output: 120 },
    { input: 1, cacheWrite: 900, cacheWrite1h: 900, cacheRead: 13500, output: 90 },
    { input: 1, cacheWrite: 700, cacheWrite1h: 700, cacheRead: 14400, output: 150 },
    { input: 1, cacheWrite: 800, cacheWrite1h: 800, cacheRead: 15100, output: 90 },
    { input: 1, cacheWrite: 500, cacheWrite1h: 500, cacheRead: 15900, output: 260 },
    { input: 1, cacheWrite: 400, cacheWrite1h: 400, cacheRead: 16400, output: 350 },
  ];

  test('matches the totals listed in fixtures/README.md', () => {
    // in 9, cw1h 16800, cr 87300, out 1240: 9 + 2 · 16800 + 0.1 · 87300 + 5 · 1240 = 9 + 33600 + 8730 + 6200
    expect(sumUsage(sessionA)).toEqual({ input: 9, cacheWrite: 16800, cacheWrite5m: 0, cacheWrite1h: 16800, cacheRead: 87300, output: 1240 });
    expect(sessionCost(sessionA)).toBeCloseTo(48539, 9);
  });

  test('equals the sum of the cost of each call', () => {
    const perCall = sessionA.reduce((total, call) => total + weightedCost(call), 0);
    expect(sessionCost(sessionA)).toBeCloseTo(perCall, 9);
  });

  test('mixes calls with and without a TTL split', () => {
    // 1.25 · 100 (no split) + 2 · 50 (1-hour)
    const calls: Usage[] = [
      { input: 0, cacheWrite: 100, cacheRead: 0, output: 0 },
      { input: 0, cacheWrite: 50, cacheWrite5m: 0, cacheWrite1h: 50, cacheRead: 0, output: 0 },
    ];
    expect(sessionCost(calls)).toBeCloseTo(225, 9);
  });

  test('is 0 for a session with no calls', () => {
    expect(sessionCost([])).toBe(0);
  });
});

describe('rent: C = c·(w + r·(T − t))', () => {
  test('uses w1h when the block lives in the 1-hour cache', () => {
    // 500 · (2 + 0.1 · 50)
    expect(rent(500, 50, DEFAULT_COST_PARAMS, '1h')).toBeCloseTo(3500, 9);
  });

  test('is only the write when no turn follows', () => {
    // 800 · 1.25
    expect(rent(800, 0)).toBeCloseTo(1000, 9);
  });

  test('reads the parameters it is given', () => {
    // 1000 · (1 + 0.2 · 10)
    expect(rent(1000, 10, { ...DEFAULT_COST_PARAMS, w: 1, r: 0.2 })).toBeCloseTo(3000, 9);
  });

  test('rejects negative tokens or turns', () => {
    expect(() => rent(-1, 10)).toThrow(RangeError);
    expect(() => rent(100, -1)).toThrow(RangeError);
  });
});

describe('memoryRent: C_mem = c_mem·(w + r·(T − 1))', () => {
  test('charges memory loaded at the first turn for every later turn', () => {
    // 1000 · (1.25 + 0.1 · 29) = 1000 · 4.15
    expect(memoryRent(1000, 30)).toBeCloseTo(4150, 9);
  });

  test('is the rent of a block that entered at turn 1', () => {
    expect(memoryRent(1234, 17)).toBeCloseTo(rent(1234, 16), 9);
    expect(memoryRent(1234, 17, DEFAULT_COST_PARAMS, '1h')).toBeCloseTo(rent(1234, 16, DEFAULT_COST_PARAMS, '1h'), 9);
  });

  test('is only the write in a one-turn session', () => {
    // 1000 · 1.25
    expect(memoryRent(1000, 1)).toBeCloseTo(1250, 9);
  });

  test('rejects sessions with no turns', () => {
    expect(() => memoryRent(1000, 0)).toThrow(RangeError);
  });
});

describe('loadNowThreshold: load now if c < p·(r·L + overhead) / ((1 − p)·(w + r·(T − t)))', () => {
  const base = { contextTokens: 60000, probability: 0.5, turnsAfter: 20 };

  test('at the threshold, loading now and waiting cost the same on average', () => {
    // (1 − p) · rent(c*, T − t) = p · (r · L + overhead)
    const threshold = loadNowThreshold(base);
    expect((1 - 0.5) * rent(threshold, 20)).toBeCloseTo(0.5 * (0.1 * 60000 + 300), 6);
  });

  test('decides the spec case on both sides of the threshold', () => {
    expect(shouldLoadNow(1900, base)).toBe(true);
    expect(shouldLoadNow(2000, base)).toBe(false);
  });

  test('rises as the context grows, because a later trip re-reads more', () => {
    expect(loadNowThreshold({ ...base, contextTokens: 120000 })).toBeGreaterThan(loadNowThreshold(base));
  });

  test('falls as more turns are left, because rent runs longer', () => {
    expect(loadNowThreshold({ ...base, turnsAfter: 40 })).toBeLessThan(loadNowThreshold(base));
  });

  test('never loads a block that is never needed, always loads one that surely is', () => {
    expect(loadNowThreshold({ ...base, probability: 0 })).toBe(0);
    expect(shouldLoadNow(1, { ...base, probability: 0 })).toBe(false);
    expect(loadNowThreshold({ ...base, probability: 1 })).toBe(Infinity);
    expect(shouldLoadNow(1e9, { ...base, probability: 1 })).toBe(true);
  });

  test('rejects probabilities outside [0, 1] and negative sizes', () => {
    expect(() => loadNowThreshold({ ...base, probability: 1.2 })).toThrow(RangeError);
    expect(() => loadNowThreshold({ ...base, probability: Number.NaN })).toThrow(RangeError);
    expect(() => loadNowThreshold({ ...base, contextTokens: -5 })).toThrow(RangeError);
  });
});

describe('maxSavings: S_max = Σ rent of rediscoveries / Σ K_s', () => {
  test('divides the rent of rediscoveries by the spend', () => {
    // (3125 + 85000) / (500000 + 300000) = 88125 / 800000
    expect(maxSavings([3125, 85000], [500000, 300000])).toBeCloseTo(0.11015625, 12);
  });

  test('is 0 with no rediscoveries or no spend', () => {
    expect(maxSavings([], [500000])).toBe(0);
    expect(maxSavings([3125], [])).toBe(0);
  });

  test('rejects negative values', () => {
    expect(() => maxSavings([-1], [100])).toThrow(RangeError);
    expect(() => maxSavings([1], [-100])).toThrow(RangeError);
  });
});
