import { describe, expect, test } from 'vitest';
import { SPEC_PARAMS } from './spec-params';
import { contextBreakdown, profile, sessionBreakdown, type SessionBlock, type Usage } from '../src/index';
import { context, session } from './helpers';

const params = SPEC_PARAMS; // w1h = 2, r = 0.1, mu = 5
const call = (cacheWrite: number, cacheRead: number, output = 0): { usage: Usage } => ({
  usage: { input: 0, cacheWrite, cacheWrite5m: 0, cacheWrite1h: cacheWrite, cacheRead, output },
});
const block = (turn: number, tokens: number, overrides: Partial<SessionBlock> = {}): SessionBlock => ({
  kind: 'tool', group: 'Read', label: `block at ${turn}`, tokens, turn, ...overrides,
});
// Object.groupBy is not in Node 20.
const byGroup = (items: { group: string; cost: number }[]): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const item of items) totals[item.group] = (totals[item.group] ?? 0) + item.cost;
  return totals;
};

describe('contextBreakdown', () => {
  // Three calls of 10,000, 12,000 and 12,500 tokens. Between calls the context grows by twice the
  // estimated size of the blocks that entered, so blocks are scaled by 2.
  const ctx = context({
    calls: [call(1000, 9000, 100), call(2000, 10000, 50), call(500, 12000, 20)],
    blocks: [
      block(1, 1000, { kind: 'prompt', group: 'prompt', label: 'Prompt' }),
      block(2, 1000, { label: 'Read src/a.ts' }),
      block(3, 250, { kind: 'reply', group: 'reply', label: 'Assistant reply' }),
    ],
  });
  const breakdown = contextBreakdown(ctx, params);

  test('the parts add up to the measured cost', () => {
    // Call costs: 2·1000 + 0.1·9000 + 5·100 = 3400; 2·2000 + 0.1·10000 + 5·50 = 5250; 2·500 + 0.1·12000 + 5·20 = 2300
    expect(breakdown.measured).toBeCloseTo(10950, 9);
    expect(breakdown.items.reduce((total, item) => total + item.cost, 0)).toBeCloseTo(10950, 9);
  });

  test('splits each call: cache reads to the blocks already there, writes to the ones that entered', () => {
    // Prefix: 10,000 − 1,000·2 = 8,000 tokens, read from the cache at every call: 0.1·8000 three times.
    // Prompt: the rest of call 1 (0.1·1000 of reads + 2·1000 of writes), then 0.1·2000 at calls 2 and 3.
    // Read: written at call 2 (2·2000), read at call 3 (0.1·2000). Reply: written at call 3 (2·500).
    expect(byGroup(breakdown.items)).toEqual({
      prefix: expect.closeTo(2400, 9),
      prompt: expect.closeTo(2500, 9),
      'tool:Read': expect.closeTo(4200, 9),
      reply: expect.closeTo(1000, 9),
      output: expect.closeTo(850, 9),
    });
  });

  test('calibrates block sizes on the measured growth, and says how long each block stayed', () => {
    const items = Object.fromEntries(breakdown.items.filter((item) => item.turn !== undefined).map((item) => [item.group, [item.tokens, item.turnsKept]]));
    expect(items).toEqual({ prefix: [8000, 2], prompt: [2000, 2], 'tool:Read': [2000, 1], reply: [500, 0] });
  });

  test('a call that writes the previous context again is a cache rebuild', () => {
    // Call 2 reads nothing from the cache: the 10,000 tokens of call 1 are written again at 2.
    const rebuilt = contextBreakdown(context({ calls: [call(1000, 9000), call(10500, 0)], blocks: [] }), params);
    expect(rebuilt.cacheRebuilds).toBe(1);
    expect(byGroup(rebuilt.items)).toEqual({ prefix: expect.closeTo(2900, 9), rebuild: expect.closeTo(20000, 9), unrecorded: expect.closeTo(1000, 9) });
  });

  test('tokens known exactly, such as thinking, are not scaled', () => {
    const thinking = contextBreakdown(context({
      calls: [call(10000, 0), call(500, 10000)],
      blocks: [block(2, 0, { kind: 'thinking', group: 'thinking', label: 'Assistant thinking', fixedTokens: 300 }), block(2, 100)],
    }), params);
    const sizes = Object.fromEntries(thinking.items.filter((item) => item.turn === 2).map((item) => [item.group, item.tokens]));
    expect(sizes).toEqual({ thinking: 300, 'tool:Read': 200 });
  });

  test('a compaction, or a large drop in size, starts a new stretch of context', () => {
    const dropped = contextBreakdown(context({ calls: [call(10000, 0), call(2000, 10000), call(1000, 4000)], blocks: [block(2, 2000)] }), params);
    const carried = dropped.items.find((item) => item.group === 'carried');
    expect(carried).toMatchObject({ turn: 3, tokens: 5000 });
    expect(dropped.items.find((item) => item.group === 'tool:Read')?.turnsKept).toBe(0);
  });

  test('a session adds its subagents and the calls only cost-state records', () => {
    const withCompaction = session('s1', '2026-09-01T10:00:00.000Z', { main: ctx, unrecordedUsage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 10 } });
    const result = sessionBreakdown(withCompaction, params);
    // 10,950 + 100 + 5 · 10
    expect(result.measured).toBeCloseTo(11100, 9);
    expect(byGroup(result.items).compaction).toBeCloseTo(150, 9);
  });
});

describe('the breakdown in the report', () => {
  test('groups the cost, picks the costliest blocks, and says how much is explained', () => {
    const ctx = context({
      calls: [call(1000, 9000, 100), call(2000, 10000, 50), call(500, 12000, 20)],
      blocks: [block(2, 1000, { label: 'Read src/a.ts' })],
    });
    const report = profile(
      { dir: '/t', sessions: [session('s1', '2026-09-01T10:00:00.000Z', { main: ctx })], stats: { lines: 0, empty: 0, malformedJson: 0, notObject: 0, ignored: 0, unknownTypes: {}, invalid: {}, orphanResults: 0 }, duplicateCalls: 0 },
      { projectRoot: '/repo', generatedAt: '2026-10-26T00:00:00.000Z', params: SPEC_PARAMS, changedBetween: () => false },
    );
    const { groups, topBlocks, explained } = report.breakdown;
    expect(groups.reduce((total, group) => total + group.cost, 0)).toBeCloseTo(report.summary.totalCost, 9);
    expect(groups.reduce((total, group) => total + group.share, 0)).toBeCloseTo(1, 9);
    expect(groups.map((group) => group.label)).toContain('Tool results: Read');
    expect(topBlocks[0]!.cost).toBeGreaterThanOrEqual(topBlocks.at(-1)!.cost);
    const unrecorded = groups.find((group) => group.group === 'unrecorded')?.share ?? 0;
    expect(explained).toBeCloseTo(1 - unrecorded, 9);
  });
});
