import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardMessage, handoffNote, lastCall, runGuard, runHandoff } from '../src/guard';

const HOUR = 3_600_000;
const big = { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 299_000, cache_creation: { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 } };
const assistant = (timestamp: string, usage: object, content: unknown[] = []): string =>
  JSON.stringify({ type: 'assistant', timestamp, message: { model: 'claude-opus-5-5', content, usage } });
const user = (timestamp: string, content: unknown): string => JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content } });

const session = [
  user('2026-10-26T09:00:00Z', 'Add a retry to the upload client'),
  assistant('2026-10-26T09:05:00Z', big, [
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/src/upload.ts' } },
    { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'Add the retry', status: 'completed' }, { content: 'Write tests', status: 'pending' }] } },
  ]),
  user('2026-10-26T09:05:01Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  assistant('2026-10-26T09:06:00Z', big, [{ type: 'text', text: 'Retry added; tests are next.' }]),
];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-guard-'));
  const transcript = join(dir, 'old.jsonl');
  writeFileSync(transcript, `${session.join('\n')}\n`);
  const out: string[] = [];
  const io = (at: string) => ({ stdout: (text: string) => out.push(text), now: () => new Date(at), stateDir: join(dir, 'state') });
  const prompt = JSON.stringify({ session_id: 'old', transcript_path: transcript, cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
  const start = (source: string) => JSON.stringify({ session_id: 'new', transcript_path: join(dir, 'new.jsonl'), cwd: '/repo', hook_event_name: 'SessionStart', source });
  return { out, io, prompt, start };
}

describe('lastCall', () => {
  it('reads the size of the last call and the cache lifetime of the latest writes', () => {
    const text = [assistant('2026-10-26T10:00:00Z', big), assistant('2026-10-26T10:01:00Z', { input_tokens: 1, cache_read_input_tokens: 300_000 })].join('\n');
    expect(lastCall(text)).toEqual({ at: Date.parse('2026-10-26T10:01:00Z'), model: 'claude-opus-5-5', context: 300_001, ttlMs: HOUR });
  });
});

describe('guardMessage', () => {
  const call = { at: 0, model: 'claude-opus-5-5', context: 300_000, ttlMs: HOUR };

  it('stops a large session whose cache expired, with the cost of writing it again', () => {
    // 300,000 tokens × 2 (one-hour cache write) × $4 per million.
    expect(guardMessage(call, 2 * HOUR, 100_000)).toContain('about $2.40');
  });

  it('lets the prompt through while the cache lives, or when the context is small', () => {
    expect(guardMessage(call, HOUR - 1, 100_000)).toBeUndefined();
    expect(guardMessage({ ...call, context: 50_000 }, 2 * HOUR, 100_000)).toBeUndefined();
  });
});

describe('guard and handoff hooks', () => {
  it('stops the first prompt after the pause, then gives the session started with /clear a note', () => {
    const { out, io, prompt, start } = setup();
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: 'block' });

    runHandoff(start('clear'), io('2026-10-26T12:01:00Z'));
    const note = (JSON.parse(out[1]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(note).toContain('1. Add a retry to the upload client');
    expect(note).toContain('Files changed: src/upload.ts');
    expect(note).toContain('- [pending] Write tests');
    expect(note).not.toContain('Add the retry');
    expect(note).toContain('Retry added; tests are next.');

    runHandoff(start('clear'), io('2026-10-26T12:02:00Z'));
    expect(out).toHaveLength(2);
  });

  it('lets the prompt through when it is sent again, and then gives no note', () => {
    const { out, io, prompt, start } = setup();
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    runGuard(prompt, {}, io('2026-10-26T12:00:30Z'));
    runHandoff(start('clear'), io('2026-10-26T12:01:00Z'));
    expect(out).toHaveLength(1);
  });

  it('does nothing on a start that is not a /clear, or on input it cannot read', () => {
    const { out, io, prompt, start } = setup();
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    runHandoff(start('startup'), io('2026-10-26T12:01:00Z'));
    expect(runGuard('not json', {}, io('2026-10-26T12:00:00Z'))).toBe(0);
    expect(out).toHaveLength(1);
  });
});

describe('handoffNote', () => {
  const edit = (timestamp: string, ...paths: string[]): string =>
    assistant(timestamp, big, paths.map((path, index) => ({ type: 'tool_use', id: `e${index}`, name: 'Write', input: { file_path: path } })));

  it('keeps a request that was pasted or starts with an image, and says which was pasted', () => {
    const note = handoffNote(
      [
        user('2026-10-26T09:00:00Z', '<pasted_content id="9f">\nError: upload failed after 3 retries\n</pasted_content id="9f">'),
        user('2026-10-26T09:10:00Z', [{ type: 'text', text: '[Image #1] is this the right chart?' }, { type: 'image', source: {} }]),
        user('2026-10-26T09:20:00Z', '<command-name>/model</command-name>'),
      ].join('\n'),
      '/repo',
      1,
    );
    expect(note).toContain('1. (with pasted text) Error: upload failed after 3 retries');
    expect(note).toContain('2. [Image #1] is this the right chart?');
    expect(note).not.toContain('pasted_content');
    expect(note).not.toContain('command-name');
  });

  it('counts the temporary files and those of Claude Code for each folder, and lists the others', () => {
    const memory = join(homedir(), '.claude', 'projects', '-repo', 'memory');
    const note = handoffNote(
      [
        edit('2026-10-26T09:00:00Z', '/repo/src/upload.ts', '/tmp/run-1/scratchpad/check.mjs', '/tmp/run-1/scratchpad/logo/sheet.html', join(memory, 'style.md')),
        edit('2026-10-26T09:10:00Z', '/home/dev/notes/plan.md', '/tmp/run-1/scratchpad/check.mjs'),
      ].join('\n'),
      '/repo',
      1,
    );
    expect(note).toContain('Files changed: src/upload.ts, /home/dev/notes/plan.md\n');
    expect(note).toContain(`not listed: 2 under /tmp/run-1/scratchpad, 1 under ${memory}`);
    expect(note).not.toContain('check.mjs');
  });

  it('lists a temporary folder that is the project itself', () => {
    expect(handoffNote(edit('2026-10-26T09:00:00Z', '/tmp/demo/src/a.ts'), '/tmp/demo', 1)).toContain('Files changed: src/a.ts');
  });

  it('keeps the files edited last when there are more than it lists', () => {
    const paths = Array.from({ length: 35 }, (_, index) => `/repo/src/file${index}.ts`);
    const note = handoffNote([edit('2026-10-26T09:00:00Z', ...paths), edit('2026-10-26T09:10:00Z', '/repo/src/file0.ts')].join('\n'), '/repo', 1)!;
    expect(note).toContain('src/file0.ts (2 edits)');
    expect(note).not.toContain('src/file5.ts');
    expect(note).toContain('src/file6.ts');
  });
});
