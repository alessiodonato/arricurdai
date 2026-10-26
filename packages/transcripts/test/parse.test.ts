import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens, parseCostParams, sessionCost } from '@arricurdai/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { parseProject, type ParsedProject, type ParsedSession } from '../src/index';

// The expected values come from fixtures/README.md.
const FIXTURES = new URL('../../../fixtures/acme-shop/', import.meta.url).pathname;
const TRANSCRIPTS = join(FIXTURES, 'claude-home/projects/-home-dev-acme-shop');

let project: ParsedProject;
let a: ParsedSession;
let b: ParsedSession;
let c: ParsedSession;

beforeAll(async () => {
  project = await parseProject(TRANSCRIPTS);
  [a, b, c] = project.sessions as [ParsedSession, ParsedSession, ParsedSession];
});

const readsOf = (session: ParsedSession) => session.main.reads.map((read) => [read.turn, read.key]);

describe('sessions', () => {
  test('are sorted by start, with the root and mode of each', () => {
    expect(project.sessions.map((s) => [s.sessionId.slice(0, 8), s.startedAt, s.entrypoint, s.root])).toEqual([
      ['11111111', '2026-09-01T09:00:02.000Z', 'cli', '/home/dev/acme-shop'],
      ['22222222', '2026-09-02T10:00:02.000Z', 'sdk-cli', '/home/dev/acme-shop'],
      ['33333333', '2026-09-03T11:00:02.000Z', 'cli', '/home/dev/acme-shop'],
    ]);
    expect(project.duplicateCalls).toBe(0);
  });
});

describe('API calls and usage', () => {
  test('count one call per message.id, even when a response takes several lines', () => {
    expect([a.main.calls.length, b.main.calls.length, c.main.calls.length]).toEqual([7, 9, 7]);
    expect(a.main.calls[0]?.messageId).toBe('msg_fx_A1');
  });

  test('match the cost-state totals once deduplicated', () => {
    expect(a.costState).toEqual({ input: 9, cacheWrite: 16800, cacheRead: 87300, output: 1240 });
    expect(a.unrecordedUsage).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    // in 9, cw1h 16800, cr 87300, out 1240: 9 + 2 · 16800 + 0.1 · 87300 + 5 · 1240
    expect(sessionCost(a.main.calls.map((call) => call.usage), parseCostParams({ r: 0.1 }))).toBeCloseTo(48539, 9);
  });

  test('keep the TTL of each cache write', () => {
    expect(a.main.cacheTtl).toBe('1h');
    expect(b.subagents[0]?.cacheTtl).toBe('5m');
    expect(a.main.calls[0]?.usage).toEqual({ input: 3, cacheWrite: 12000, cacheWrite5m: 0, cacheWrite1h: 12000, cacheRead: 0, output: 180 });
  });

  test('find the compaction call that only cost-state records', () => {
    expect(c.unrecordedUsage).toEqual({ input: 1500, cacheWrite: 200, cacheRead: 15000, output: 1200 });
  });
});

describe('context reads', () => {
  test('session A: first reads, with the call where each result entered', () => {
    expect(readsOf(a)).toEqual([
      [2, 'file:src/checkout.ts'],
      [3, 'search:applyDiscount @ src'],
      [3, 'file:package.json'],
      [4, 'file:src/pricing.ts'],
      [5, 'list:src [-name *.test.ts]'],
      [6, 'file:src/cart.ts'],
    ]);
    expect(a.main.reads.map((read) => read.tool)).toEqual(['Read', 'grep', 'cat', 'sed', 'find', 'Read']);
  });

  test('session B: re-reads, an output saved to disk, no read for pnpm test', () => {
    expect(readsOf(b)).toEqual([
      [2, 'file:src/checkout.ts'],
      [3, 'file:src/pricing.ts'],
      [4, 'search:applyDiscount @ src'],
      [5, 'file:src/cart.ts'],
      [7, 'file:logs/app.log'],
    ]);
  });

  test('session C: cd + cat, no read for a redirect, a read after the compaction', () => {
    expect(readsOf(c)).toEqual([
      [2, 'file:src/pricing.ts'],
      [3, 'file:src/checkout.ts'],
      [5, 'file:src/db/orders.ts'],
      [7, 'file:src/checkout.ts'],
    ]);
    expect(c.main.compactions).toEqual([5]);
  });

  test('size is the estimated tokens of the tool result the model saw', () => {
    const source = readFileSync(join(FIXTURES, 'project/src/checkout.ts'), 'utf8');
    const numbered = source.replace(/\n$/, '').split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');
    expect(a.main.reads[0]?.tokens).toBe(estimateTokens(numbered));
  });

  test('a saved output counts only its preview', () => {
    const log = b.main.reads.find((read) => read.target === 'logs/app.log')!;
    const fullOutput = readFileSync(join(TRANSCRIPTS, '22222222-2222-4222-8222-222222222222/tool-results/k3x9q2m7p.txt'), 'utf8');
    expect(log.persisted).toBe(true);
    expect(log.tokens).toBeGreaterThan(estimateTokens(fullOutput.slice(0, 2000)));
    expect(log.tokens).toBeLessThan(estimateTokens(fullOutput) / 10);
  });

  test('an identical search result has the same hash in two sessions', () => {
    const searchA = a.main.reads.find((read) => read.kind === 'search')!;
    const searchB = b.main.reads.find((read) => read.kind === 'search')!;
    expect(searchB.resultHash).toBe(searchA.resultHash);
    expect(b.main.reads[0]?.resultHash).not.toBe(searchA.resultHash);
  });
});

describe('subagents', () => {
  test('have their own context, type and link to the parent call', () => {
    const [agent] = b.subagents;
    expect(b.subagents).toHaveLength(1);
    expect(agent).toMatchObject({ kind: 'subagent', agentId: 'a1b2c3d4e5f6a7b8c', agentType: 'Explore', parentToolUseId: 'toolu_fx_B5' });
    expect(agent?.calls).toHaveLength(3);
    expect(agent?.reads.map((read) => [read.turn, read.key])).toEqual([[2, 'file:src/db/orders.ts'], [3, 'list:src/db']]);
  });

  test('are part of the session cost recorded in cost-state', () => {
    expect(b.costState).toEqual({ input: 15, cacheWrite: 23250, cacheRead: 128150, output: 1600 });
    expect(b.unrecordedUsage).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});

describe('memory', () => {
  test('lists the files loaded at the start, with their type', () => {
    expect(a.main.memory.map((m) => [m.type, m.path, m.turn, m.source])).toEqual([
      ['User', '/home/dev/.claude/CLAUDE.md', 1, 'instructions'],
      ['Project', '/home/dev/acme-shop/CLAUDE.md', 1, 'instructions'],
      ['Project', '/home/dev/acme-shop/docs/conventions.md', 1, 'instructions'],
      ['Project', '/home/dev/acme-shop/.claude/CLAUDE.md', 1, 'instructions'],
      ['Project', '/home/dev/acme-shop/.claude/rules/testing.md', 1, 'instructions'],
      ['Local', '/home/dev/acme-shop/CLAUDE.local.md', 1, 'instructions'],
      ['AutoMem', '/home/dev/.claude/projects/-home-dev-acme-shop/memory/MEMORY.md', 1, 'instructions'],
    ]);
    const claudeMd = a.main.memory[1]!;
    expect(claudeMd.tokens).toBe(estimateTokens(claudeMd.content));
  });

  test('knows the sessions record their memory, because they have attachment lines', () => {
    expect(project.sessions.map((s) => s.recordsMemory)).toEqual([true, true, true]);
  });

  test('records memory loaded on demand at the call where it entered', () => {
    const nested = c.main.memory.filter((m) => m.source === 'nested');
    expect(nested.map((m) => [m.path, m.turn])).toEqual([['/home/dev/acme-shop/src/db/CLAUDE.md', 5]]);
  });
});

describe('file changes and agent text', () => {
  test('come from Edit and from Bash commands that write', () => {
    expect(a.fileChanges.map((f) => [f.tool, f.path])).toEqual([['Edit', 'src/cart.ts']]);
    expect(b.fileChanges.map((f) => [f.tool, f.path])).toEqual([['Edit', 'src/pricing.ts']]);
    expect(c.fileChanges.map((f) => [f.tool, f.path])).toEqual([['Bash', '/tmp/checkout-copy.ts']]);
  });

  test('agent text holds assistant messages and tool call inputs', () => {
    expect(b.agentText).toContain('pnpm test');
    expect(a.agentText.some((text) => text.includes('`computeTotals()`'))).toBe(true);
    expect(a.agentText).not.toContain('Start from the checkout module.');
  });
});

describe('broken lines', () => {
  test('are counted by category and skipped, never thrown', () => {
    expect(c.stats).toMatchObject({
      empty: 1, malformedJson: 1, notObject: 2, unknownTypes: { 'future-feature': 1 }, invalid: { assistant: 1 }, orphanResults: 0,
    });
    expect(a.stats).toMatchObject({ malformedJson: 0, notObject: 0, unknownTypes: {}, invalid: {} });
    expect(project.stats).toMatchObject({ malformedJson: 1, notObject: 2, empty: 1 });
  });
});
