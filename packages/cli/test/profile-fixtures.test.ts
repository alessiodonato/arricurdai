import { profile, reportSchema, type Report, parseCostParams } from '@arricurdai/core';
import { parseProject } from '@arricurdai/transcripts';
import { beforeAll, describe, expect, test } from 'vitest';

// The whole pipeline on fixtures/acme-shop. Every expected number is computed by hand from
// fixtures/README.md, with w = 1.25, w1h = 2, r = 0.1, mu = 5. No commit happens between the
// sessions, so the git answer is always "not changed".
const TRANSCRIPTS = new URL('../../../fixtures/acme-shop/claude-home/projects/-home-dev-acme-shop', import.meta.url).pathname;

let report: Report;

beforeAll(async () => {
  const project = await parseProject(TRANSCRIPTS);
  report = profile(project, { projectRoot: '/home/dev/acme-shop', generatedAt: '2026-10-26T00:00:00.000Z', params: parseCostParams({ r: 0.1 }), changedBetween: () => false });
});

describe('profile of the acme-shop fixtures', () => {
  test('is a valid report', () => {
    expect(reportSchema.safeParse(report).success).toBe(true);
    expect(report.window).toEqual({ sessions: 3, available: 3, from: '2026-09-01T09:00:02.000Z', to: '2026-09-03T11:00:02.000Z' });
  });

  test('costs each session with its subagents and its compaction', () => {
    // A: 9 + 2 · 16800 + 0.1 · 87300 + 5 · 1240
    // B: 15 + 2 · 16750 + 1.25 · 6500 + 0.1 · 128150 + 5 · 1600
    // C: 1511 + 2 · 17250 + 1.25 · 200 + 0.1 · 89300 + 5 · 2200
    expect(report.sessions.map((s) => s.cost)).toEqual([48539, 62455, 56191]);
    expect(report.sessions.map((s) => [s.turns, s.subagentCalls, s.compactions])).toEqual([[7, 0, 0], [9, 3, 0], [7, 0, 1]]);
  });

  test('finds the rediscoveries listed in fixtures/README.md and their rent', () => {
    // B: checkout 90 · (2 + 0.1 · 7), pricing 66 · (2 + 0.1 · 6), search 57 · (2 + 0.1 · 5)
    // C: checkout 90 · (2 + 0.1 · 2), its rent cut by the compaction; orders 42 · 2; checkout again 90 · 2
    expect(report.sessions.map((s) => [s.rediscoveries, s.rediscoveryTokens])).toEqual([[0, 0], [3, 213], [3, 222]]);
    expect(report.sessions[1]?.rediscoveryCost).toBeCloseTo(557.1, 9);
    expect(report.sessions[2]?.rediscoveryCost).toBeCloseTo(462, 9);
    expect(report.rediscoveries.map((r) => [r.target, r.count, r.tokens, Number(r.cost.toFixed(2))])).toEqual([
      ['src/checkout.ts', 3, 270, 621],
      ['src/pricing.ts', 1, 66, 171.6],
      ['applyDiscount', 1, 57, 142.5],
      ['src/db/orders.ts', 1, 42, 84],
    ]);
  });

  test('computes the summary and S_max', () => {
    expect(report.summary.totalCost).toBe(167185);
    expect(report.summary.rediscoveryCost).toBeCloseTo(1019.1, 9);
    expect(report.summary.maxSavings).toBeCloseTo(1019.1 / 167185, 12);
    // 435 rediscovered tokens out of 1523 tokens of context reads
    expect(report.summary.rediscoveryShare).toBeCloseTo(435 / 1523, 12);
    expect(report.approximations).toEqual([]);
  });

  test('prices memory loaded at the start and on demand', () => {
    const nested = report.memory.files.find((f) => f.source === 'nested');
    // src/db/CLAUDE.md enters at call 5 and the compaction right after drops it: 18 · 2
    expect(nested).toMatchObject({ path: 'src/db/CLAUDE.md', sessions: 1, cost: 36 });
    expect(report.memory.files.find((f) => f.path === 'CLAUDE.md')).toMatchObject({ sessions: 3, cost: expect.closeTo(102 * (2.6 + 2.8 + 2.6), 9) });
  });

  test('lists the memory lines that no session used', () => {
    expect(report.memory.unusedLines.map((l) => [l.file, l.line])).toEqual([
      ['CLAUDE.md', 6],
      ['CLAUDE.md', 7],
      ['docs/conventions.md', 3],
      ['.claude/CLAUDE.md', 1],
      ['CLAUDE.local.md', 1],
      ['/home/dev/.claude/projects/-home-dev-acme-shop/memory/MEMORY.md', 2],
      ['src/db/CLAUDE.md', 1],
    ]);
    expect(report.memory.unverifiableLines.map((l) => l.text)).toEqual(['Answer in English, briefly.', 'Keep commit messages short and in the imperative mood.']);
    expect(report.memory.usedLines).toBe(6);
  });

  test('breaks the whole cost down into groups that add up to it', () => {
    const { groups, topBlocks, explained } = report.breakdown;
    expect(groups.reduce((total, group) => total + group.cost, 0)).toBeCloseTo(167185, 6);
    expect(explained).toBeGreaterThan(0);
    expect(explained).toBeLessThanOrEqual(1);
    expect(topBlocks.length).toBeLessThanOrEqual(10);
    // Output is priced at mu = 5: 5 · (1240 + 1310 + 290 + 1000)
    expect(groups.find((group) => group.group === 'output')?.cost).toBeCloseTo(19200, 9);
  });

  test('has no what-if scenario: no pause and no large context in the fixtures', () => {
    expect(report.whatIf.scenarios).toEqual([]);
  });

  test('counts the broken lines of session C', () => {
    expect(report.lines).toEqual({ total: 109, malformed: 3, unknownTypes: { 'future-feature': 1 }, invalid: { assistant: 1 }, orphanResults: 0 });
  });
});
