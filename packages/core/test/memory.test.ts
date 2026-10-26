import { describe, expect, test } from 'vitest';
import { classifyMemoryLines, DEFAULT_COST_PARAMS, extractTerms, memoryLines, memoryLoadCosts } from '../src/index';
import { calls, context, read, session } from './helpers';

describe('extractTerms', () => {
  test('takes code spans, and the name of a function written with ()', () => {
    expect(extractTerms('Run the tests with `pnpm test`.')).toEqual(['pnpm test']);
    expect(extractTerms('The legacy `oldCheckout()` helper is deprecated.')).toEqual(['oldCheckout()', 'oldCheckout']);
  });

  test('takes paths and the file name at their end', () => {
    expect(extractTerms('Prices live in `src/pricing.ts`.')).toEqual(['src/pricing.ts', 'pricing.ts']);
    expect(extractTerms('Deploy with `scripts/deploy.sh --prod`.')).toEqual(['scripts/deploy.sh --prod', 'scripts/deploy.sh', 'deploy.sh']);
    expect(extractTerms('Edit src/app/main.ts with care, and see docs/ and package.json')).toEqual(['src/app/main.ts', 'main.ts', 'docs/', 'package.json']);
  });

  test('takes the targets of links, such as the topic files of MEMORY.md', () => {
    expect(extractTerms('- [Billing](billing.md) — events arrive in `src/billing/webhook.ts`')).toEqual([
      'src/billing/webhook.ts', 'webhook.ts', 'billing.md',
    ]);
  });

  test('ignores words that only look like paths in prose', () => {
    expect(extractTerms('Use and/or, e.g. v2.0 or 3.14, and mail me@example.com')).toEqual([]);
    expect(extractTerms('See https://example.com/docs/x.md')).toEqual([]);
    expect(extractTerms('Answer in English, briefly.')).toEqual([]);
  });

  test('leaves out @imports, which are measured as their own files', () => {
    expect(extractTerms('See @docs/conventions.md for code style.')).toEqual([]);
  });
});

describe('memoryLines', () => {
  const content = [
    '# Shop', '', '- Run the tests with `pnpm test`.', '* Keep commit messages short.', '1. [ ] Read `README.md` first',
    '---', '| a | b |', '|---|---|', '```bash', 'pnpm lint --fix', '```', 'See @docs/conventions.md',
    '> WARNING: MEMORY.md is 210 lines (limit: 200). Only part of it was loaded.',
  ].join('\n');

  test('keeps the lines worth checking, with their line numbers and without list markers', () => {
    expect(memoryLines('CLAUDE.md', content).map((l) => [l.line, l.kind, l.text])).toEqual([
      [3, 'verifiable', 'Run the tests with `pnpm test`.'],
      [4, 'unverifiable', 'Keep commit messages short.'],
      [5, 'verifiable', 'Read `README.md` first'],
      [7, 'unverifiable', '| a | b |'],
      [10, 'verifiable', 'pnpm lint --fix'],
      [12, 'import', 'See @docs/conventions.md'],
    ]);
  });

  test('treats a line in a code block as a command', () => {
    expect(memoryLines('CLAUDE.md', content).find((l) => l.line === 10)?.terms).toEqual(['pnpm lint --fix']);
  });
});

describe('classifyMemoryLines', () => {
  const content = '- Use `pnpm test`.\n- Prices in `src/pricing.ts`.\n- Deploy with `deploy.sh`.\n- Be brief.';
  const files = [{ file: 'CLAUDE.md', content, loadedIn: new Set(['s1', 's2']) }];

  test('a line is used when one of its terms appears in a tool call or an assistant message', () => {
    const usage = classifyMemoryLines(files, [session('s1', '2026-09-01', { agentText: ['pnpm test'] })]);
    expect(usage.used.map((l) => l.line)).toEqual([1]);
    expect(usage.unused.map((l) => l.line)).toEqual([2, 3]);
    expect(usage.unverifiable.map((l) => l.line)).toEqual([4]);
  });

  test('the paths an agent read count too, even when its command used a relative path', () => {
    const reading = session('s1', '2026-09-01', { main: context({ reads: [read('file:src/pricing.ts')] }) });
    expect(classifyMemoryLines(files, [reading]).used.map((l) => l.line)).toEqual([2]);
  });

  test('a session that did not load the file cannot use its lines', () => {
    const onlyFirst = [{ file: 'CLAUDE.md', content, loadedIn: new Set(['s1']) }];
    const sessions = [session('s1', '2026-09-01'), session('s2', '2026-09-02', { agentText: ['pnpm test'] })];
    expect(classifyMemoryLines(onlyFirst, sessions).used).toEqual([]);
  });

  test('one session that uses a line is enough', () => {
    const sessions = [session('s1', '2026-09-01'), session('s2', '2026-09-02', { agentText: ['bash deploy.sh'] })];
    expect(classifyMemoryLines(files, sessions).used.map((l) => l.line)).toEqual([3]);
  });
});

describe('memoryLoadCosts', () => {
  const load = (path: string, source: 'instructions' | 'nested', turn: number | undefined, tokens = 100) =>
    ({ path, type: 'Project', content: '', tokens, source, turn });

  test('memory loaded at the start pays c·(w + r·(T − 1)), once per file', () => {
    const ctx = context({ calls: calls(30), cacheTtl: '5m', memory: [load('/a/CLAUDE.md', 'instructions', 1, 1000), load('/a/CLAUDE.md', 'instructions', 12, 1000)] });
    // 1000 · (1.25 + 0.1 · 29)
    expect(memoryLoadCosts(ctx, DEFAULT_COST_PARAMS)).toEqual([{ path: '/a/CLAUDE.md', type: 'Project', source: 'instructions', tokens: 1000, cost: expect.closeTo(4150, 9) }]);
  });

  test('memory loaded on demand pays rent from its turn to the end of its context', () => {
    const ctx = context({ calls: calls(10), compactions: [8], memory: [load('/a/src/CLAUDE.md', 'nested', 4)] });
    // 100 · (2 + 0.1 · (8 − 4))
    expect(memoryLoadCosts(ctx, DEFAULT_COST_PARAMS)[0]?.cost).toBeCloseTo(240, 9);
  });

  test('a context with no calls pays nothing', () => {
    expect(memoryLoadCosts(context({ calls: [], memory: [load('/a/CLAUDE.md', 'instructions', 1)] }), DEFAULT_COST_PARAMS)).toEqual([]);
  });
});
