import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECALL_LABEL } from '@arricurdai/core';
import { afterAll, describe, expect, test } from 'vitest';
import { GUARD_STOP, HANDOFF_NOTE, parseProject, toolLabel } from '../src/index';

const dir = mkdtempSync(join(tmpdir(), 'arricurdai-traces-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = (minute: number) => `2026-10-11T09:${String(minute).padStart(2, '0')}:00.000Z`;
const base = (minute: number) => ({ timestamp: at(minute), cwd: '/home/dev/shop', sessionId: '44444444-4444-4444-4444-444444444444', version: '2.1.0', uuid: `u${minute}` });
const assistant = (minute: number) => ({
  ...base(minute),
  type: 'assistant',
  message: { id: `msg_${minute}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 1 } },
});
const boundary = (minute: number, trigger: string) => ({ ...base(minute), type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger, preTokens: 170000 }, content: 'Conversation compacted' });

async function parse(lines: unknown[]) {
  writeFileSync(join(dir, '44444444-4444-4444-4444-444444444444.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const { sessions } = await parseProject(dir);
  return sessions[0]!;
}

describe('what the hooks and the limit leave in a transcript', () => {
  test('tells automatic compactions from the ones the user asked for', async () => {
    const session = await parse([assistant(1), boundary(2, 'auto'), assistant(3), boundary(4, 'manual'), assistant(5)]);
    expect(session.main.compactions).toEqual([1, 2]);
    expect(session.main.autoCompactions).toEqual([1]);
  });

  test('counts the prompts the guard stopped', async () => {
    const stop = { ...base(2), type: 'system', subtype: 'informational', content: `${GUARD_STOP} for 3 hours and its prompt cache expired.` };
    const other = { ...base(3), type: 'system', subtype: 'informational', content: 'Something else.' };
    const session = await parse([assistant(1), stop, other, assistant(4)]);
    expect(session.guardStops).toBe(1);
  });

  test('sees a session that started from the note', async () => {
    const note = { ...base(1), type: 'attachment', attachment: { type: 'hook_additional_context', content: [`${HANDOFF_NOTE}, last active today.`] }, rendered: [{ content: 'text' }] };
    expect((await parse([note, assistant(2)])).startedFromNote).toBe(true);
    const hint = { ...note, attachment: { type: 'hook_additional_context', content: ['To look up what was asked, run recall.'] } };
    expect((await parse([hint, assistant(2)])).startedFromNote).toBe(false);
  });
});

describe('toolLabel', () => {
  test('shows a search of earlier sessions whatever the path, without its words', () => {
    const label = (command: string) => toolLabel('Bash', { command }, '/repo', '/repo');
    expect(label('arricurdai recall "invoice vat"')).toBe(RECALL_LABEL);
    expect(label('node "/Users/someone/projects/tools/node_modules/arricurdai/dist/bin.js" recall "invoice vat"')).toBe(RECALL_LABEL);
    expect(label('node /opt/arricurdAI/packages/cli/dist/bin.js recall vat --project .')).toBe(RECALL_LABEL);
  });

  test('leaves other commands as they are', () => {
    expect(toolLabel('Bash', { command: 'grep recall notes.md' }, '/repo', '/repo')).toBe('Bash: grep recall notes.md');
  });
});
