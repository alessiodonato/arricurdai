import { profile, type Report } from '@arricurdai/core';
import { describe, expect, test } from 'vitest';
import { formatInteger, formatPercent, renderReport } from '../src/render';

const emptyReport = (): Report =>
  profile(
    { dir: '/home/me/.claude/projects/-home-me-shop', sessions: [], stats: { lines: 0, empty: 0, malformedJson: 0, notObject: 0, ignored: 0, unknownTypes: {}, invalid: {}, orphanResults: 0 }, duplicateCalls: 0 },
    { projectRoot: '/home/me/shop', generatedAt: '2026-10-26T00:00:00.000Z', changedBetween: () => false },
  );

describe('formatPercent', () => {
  test('shows two decimals under 1%, one under 10%, none above, and 0% for nothing', () => {
    expect([0, 0.0061, 0.029, 0.29, 1].map(formatPercent)).toEqual(['0%', '0.61%', '2.9%', '29%', '100%']);
  });
});

describe('formatInteger', () => {
  test('rounds and groups thousands', () => {
    expect([0, 621.4, 1224.5, 8148592].map(formatInteger)).toEqual(['0', '621', '1,225', '8,148,592']);
  });
});

describe('renderReport', () => {
  test('shows the home folder as ~ and handles a project with no sessions', () => {
    const text = renderReport(emptyReport(), { colors: false, home: '/home/me' });
    expect(text).toContain('arricurdai profile · ~/shop\nTranscripts: ~/.claude/projects/-home-me-shop');
    expect(text).toContain('No sessions to measure in this folder.');
    expect(text).toContain('No context was read again from an earlier session.');
    expect(text).toContain('No memory files were loaded.');
  });

  test('lists the ten most costly rediscoveries and says how many more there are', () => {
    const report = emptyReport();
    report.rediscoveries = Array.from({ length: 12 }, (_, i) => ({ key: `file:src/f${i}.ts`, kind: 'file' as const, target: `src/f${i}.ts`, count: 1, tokens: 100, cost: 1000 - i }));
    const text = renderReport(report, { colors: false });
    expect(text).toContain('src/f9.ts');
    expect(text).not.toContain('src/f10.ts');
    expect(text).toContain('… 2 more with --json');
  });

  test('cuts long targets to fit the table', () => {
    const report = emptyReport();
    report.rediscoveries = [{ key: `search:${'x'.repeat(80)} @ src`, kind: 'search', target: 'x'.repeat(80), count: 2, tokens: 10, cost: 20 }];
    expect(renderReport(report, { colors: false })).toMatch(/ 1 {2}search x+… +2 +10 +20\n/);
  });

  test('says "session" for a single session', () => {
    const report = emptyReport();
    report.window.sessions = 1;
    expect(renderReport(report, { colors: false })).toContain('Memory lines never used in the last session\n');
  });

  test('marks the approximations', () => {
    const report = emptyReport();
    report.approximations = ['The project has no git history.'];
    expect(renderReport(report, { colors: false })).toContain('  ≈ The project has no git history.\n');
  });
});
