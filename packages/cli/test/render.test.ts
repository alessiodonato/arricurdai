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

  test('shows where the cost goes, with the cache rebuilds and the costliest blocks', () => {
    const report = emptyReport();
    report.breakdown = {
      groups: [
        { group: 'rebuild', label: 'Cache rebuilt after a pause', tokens: 0, cost: 44_490_054, share: 0.278 },
        { group: 'tool:Bash', label: 'Tool results: Bash', tokens: 720_665, cost: 12_635_816, share: 0.079 },
        { group: 'tool:Web', label: 'Tool results: Web', tokens: 2_526, cost: 23_571, share: 0.0001 },
      ],
      topBlocks: [{ sessionId: 's1', group: 'tool:Bash', label: 'Bash: npm run build', tokens: 12_400, turn: 230, turnsKept: 1_985, cost: 2_400_000, share: 0.02 }],
      explained: 0.983,
      cacheRebuilds: 41,
    };
    const text = renderReport(report, { colors: false });
    expect(text).toContain('Where the cost goes');
    expect(text).toMatch(/Cache rebuilt after a pause \(41 times\) +44,490,054 +28%\n/);
    expect(text).toMatch(/Tool results: Bash +720,665 +12,635,816 +7\.9%\n/);
    expect(text).toContain('… 1 more under 1.0% each, with --json');
    expect(text).toContain('Known blocks explain 98% of the cost');
    expect(text).toMatch(/ 1 {2}Bash: npm run build +12,400 +230 +1,985 +2,400,000\n/);
  });

  test('shows what other compactions would have saved, and when they would cost more', () => {
    const report = emptyReport();
    report.whatIf = {
      summaryTokens: 9945,
      scenarios: [
        { policy: 'before-rebuild', saving: 108_006_669, share: 0.676, compactions: 38 },
        { policy: 'cap', cap: 200_000, saving: -1_200, share: -0.004, compactions: 3 },
      ],
    };
    const text = renderReport(report, { colors: false });
    expect(text).toContain('What if');
    expect(text).toMatch(/Compact before each pause \(38 compactions\) +saves 68% +108,006,669\n/);
    expect(text).toMatch(/Keep the context under 200,000 tokens \(3 compactions\) +costs 0\.40% more +1,200\n/);
    expect(text).toContain('with summaries of 9,945 tokens');
  });

  test('says nothing about what-ifs when no scenario applies', () => {
    expect(renderReport(emptyReport(), { colors: false })).not.toContain('What if');
  });

  test('marks the approximations', () => {
    const report = emptyReport();
    report.approximations = ['The project has no git history.'];
    expect(renderReport(report, { colors: false })).toContain('  ≈ The project has no git history.\n');
  });
});
