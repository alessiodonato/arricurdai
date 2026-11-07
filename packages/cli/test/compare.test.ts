import { join } from 'node:path';
import { GUARD_STOP, HANDOFF_NOTE } from '@arricurdai/transcripts';
import { describe, expect, test } from 'vitest';
import { type CompareCommandOptions, renderComparison, runCompare } from '../src/compare';
import { guardMessage, handoffNote } from '../src/guard';
import type { CommandIO } from '../src/run-profile';

const REPO = new URL('../../../', import.meta.url).pathname;
const FIXTURE = {
  project: join(REPO, 'fixtures/acme-shop/project'),
  transcripts: join(REPO, 'fixtures/acme-shop/claude-home/projects/-home-dev-acme-shop'),
};
// The fixtures hold sessions started on 1, 2 and 3 September 2026.
const SINCE = '2026-09-03';

async function run(options: CompareCommandOptions) {
  let stdout = '';
  let stderr = '';
  const io: CommandIO = {
    cwd: REPO,
    env: { HOME: '/nowhere' },
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    colors: false,
  };
  const code = await runCompare({ ...FIXTURE, ...options }, io);
  return { code, stdout, stderr };
}

describe('arricurdai compare on the fixtures', () => {
  test('prints the two periods, what each part did, what it added and how to read it, in this order', async () => {
    const { code, stdout, stderr } = await run({ since: SINCE });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const titles = ['Cost per call', 'What each part did on the later sessions', 'What arricurdAI added on the later sessions', 'How to read this'];
    const places = titles.map((title) => stdout.indexOf(title));
    expect(places.every((place) => place >= 0)).toBe(true);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(stdout).toMatch(/Sessions\s+2\s+1/);
  });

  test('says when there was nothing to take away, and that the sample is small', async () => {
    const { stdout } = await run({ since: SINCE });
    expect(stdout).toContain('no automatic compaction in these sessions');
    expect(stdout).toContain('no session started from the note');
    expect(stdout).toContain('Few calls');
    expect(stdout).toContain('not an experiment');
  });

  test('prints JSON with --json', async () => {
    const { stdout } = await run({ since: SINCE, json: true });
    const comparison = JSON.parse(stdout);
    expect([comparison.before.sessions, comparison.after.sessions]).toEqual([2, 1]);
    expect(comparison.withoutBoth.cost).toBeCloseTo(comparison.after.cost, 6);
  });

  test('leaves out the sessions from --until on', async () => {
    const { stdout } = await run({ since: '2026-09-02', until: SINCE, json: true });
    expect(JSON.parse(stdout).after.sessions).toBe(1);
  });

  test.each([
    [{ since: 'yesterday' }, '--since must be a date'],
    [{ since: SINCE, until: 'soon' }, '--until must be a date'],
    [{ since: SINCE, window: 'large' }, '--window must be a whole number'],
    [{ since: '2020-01-01' }, 'no sessions started before 2020-01-01'],
    [{ since: '2030-01-01' }, 'no sessions started from 2030-01-01 on'],
    [{}, '--since is required'],
  ])('explains in one line what is wrong with %j', async (options, message) => {
    const { code, stdout, stderr } = await run(options);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(message);
  });
});

describe('renderComparison', () => {
  test('counts one of a thing in the singular', async () => {
    const comparison = JSON.parse((await run({ since: SINCE, json: true })).stdout);
    comparison.limit = 170_000;
    comparison.chained = 1;
    comparison.undated = 1;
    comparison.withoutLimit.skipped = 1;
    comparison.after = { ...comparison.after, notes: 1, recallSearches: 1 };
    const text = renderComparison(comparison, { colors: false });
    for (const words of ['1 compaction at up to 170,000', '1 session goes on from the one stopped', '1 note', '1 search', '1 session has no start time']) {
      expect(text).toContain(words);
    }
  });
});

describe('the words compare looks for in a transcript', () => {
  test('are the words the guard writes', () => {
    const call = { at: 0, model: 'claude-opus-5-5', context: 300_000, ttlMs: 3_600_000 };
    expect(guardMessage(call, 7_200_000, 100_000)).toContain(GUARD_STOP);
  });

  test('are the words the handoff note starts with', () => {
    const transcript = [
      JSON.stringify({ type: 'user', timestamp: '2026-10-26T09:00:00Z', message: { role: 'user', content: 'Add a retry' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-26T09:05:00Z', message: { content: [{ type: 'text', text: 'Done.' }] } }),
    ].join('\n');
    expect(handoffNote(transcript, '/repo', 300_000)).toContain(HANDOFF_NOTE);
  });
});
