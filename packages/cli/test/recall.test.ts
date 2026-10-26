import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGuard, runHandoff } from '../src/guard';
import { formatHits, runRecall, search, sessionChunks, terms } from '../src/recall';

const user = (timestamp: string, content: unknown, extra: object = {}): string => JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content }, ...extra });
const assistant = (timestamp: string, content: unknown[], usage: object = { input_tokens: 1, cache_read_input_tokens: 10 }): string =>
  JSON.stringify({ type: 'assistant', timestamp, message: { model: 'claude-opus-5-5', content, usage } });

const older = [
  user('2026-10-01T09:00:00Z', 'Perché le fatture dei clienti esteri falliscono?'),
  assistant('2026-10-01T09:01:00Z', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/invoice.ts' } }]),
  user('2026-10-01T09:01:01Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'export function vatFor(country) {}' }]),
  assistant('2026-10-01T09:02:00Z', [
    { type: 'text', text: 'The VAT code was missing for foreign customers.\nWe decided to default to reverse charge for EU invoices.' },
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/src/invoice.ts' } },
  ]),
  user('2026-10-01T10:00:00Z', 'Add a dark mode toggle to the settings page'),
  assistant('2026-10-01T10:05:00Z', [{ type: 'text', text: 'Dark mode added with a CSS variable switch.' }]),
  user('2026-10-02T09:00:00Z', 'Summary: we chose Postgres over SQLite for the reports.', { isCompactSummary: true }),
];

describe('terms', () => {
  it('splits identifiers, leaves out common words and folds singular and plural', () => {
    const found = terms('Le fatture dei clienti: MethodAllowList in routes_test, testing');
    expect(found).toEqual(expect.arrayContaining(['fattur', 'client', 'methodallowlist', 'method', 'allow', 'list', 'rout', 'test']));
    expect(found).not.toContain('le');
    expect(terms('fattura cliente')).toEqual(['fattur', 'client']);
  });
});

describe('sessionChunks', () => {
  it('pairs each request with its replies and edits, leaves out tool results, and keeps compaction summaries', () => {
    const chunks = sessionChunks(older.join('\n'), 'old');
    expect(chunks.map((chunk) => chunk.request)).toEqual(['Perché le fatture dei clienti esteri falliscono?', 'Add a dark mode toggle to the settings page', '']);
    expect(chunks[0]!.text).toContain('reverse charge');
    expect(chunks[0]!.text).toContain('[Edit /repo/src/invoice.ts]');
    expect(chunks[0]!.text).not.toContain('vatFor');
    expect(chunks[2]!.text).toContain('Postgres');
  });
});

describe('search', () => {
  const chunks = sessionChunks(older.join('\n'), 'old');

  it('ranks first the chunk that matches the words, whatever the ending', () => {
    const [first] = search(chunks, 'fattura cliente estero', 5);
    expect(first?.chunk.request).toContain('fatture');
    expect(first?.excerpt).toContain('fatture');
  });

  it('finds compaction summaries, and nothing for common words only', () => {
    expect(search(chunks, 'postgres', 5)[0]?.chunk.request).toBe('');
    expect(search(chunks, 'cosa dobbiamo fare', 5)).toEqual([]);
  });

  it('prints at least one match and stays within the token budget', () => {
    const text = formatHits(search(chunks, 'fatture dark postgres', 5), 'fatture dark postgres', 1, 30);
    expect(text).toContain('[1]');
    expect(text).not.toContain('[2]');
  });
});

describe('runRecall', () => {
  it('searches every session of the folder except the current one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-recall-'));
    writeFileSync(join(dir, 'old.jsonl'), older.join('\n'));
    writeFileSync(join(dir, 'current.jsonl'), user('2026-10-26T09:00:00Z', 'fatture fatture fatture'));
    let stdout = '';
    const io = { cwd: dir, env: { CLAUDE_CODE_SESSION_ID: 'current' }, stdout: (text: string) => { stdout += text; }, stderr: () => {}, now: () => new Date(), colors: false };
    expect(await runRecall(['fatture', 'clienti'], { transcripts: dir }, io)).toBe(0);
    expect(stdout).toContain('in 1 earlier session.');
    expect(stdout).toContain('session old');
  });
});

describe('handoff with recall', () => {
  it('adds the earlier context that matches the stopped prompt, and how to look up more', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-recall-'));
    writeFileSync(join(dir, 'old.jsonl'), older.join('\n'));
    const big = { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 299_000, cache_creation: { ephemeral_1h_input_tokens: 1_000 } };
    const last = join(dir, 'last.jsonl');
    writeFileSync(last, [user('2026-10-25T09:00:00Z', 'Refactor the invoice module'), assistant('2026-10-25T09:05:00Z', [{ type: 'text', text: 'Refactor done.' }], big)].join('\n'));
    const out: string[] = [];
    const io = (at: string) => ({ stdout: (text: string) => out.push(text), now: () => new Date(at), stateDir: join(dir, 'state'), recallCommand: 'arricurdai recall' });

    runGuard(JSON.stringify({ session_id: 'last', transcript_path: last, cwd: '/repo', prompt: 'why did foreign invoices fail? fatture clienti' }), {}, io('2026-10-26T12:00:00Z'));
    runHandoff(JSON.stringify({ session_id: 'new', transcript_path: join(dir, 'new.jsonl'), cwd: '/repo', source: 'clear' }), io('2026-10-26T12:01:00Z'));

    const note = (JSON.parse(out[1]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(note).toContain('Note from arricurdai on the previous session');
    expect(note).toContain('Earlier context that matches the prompt you were about to send');
    expect(note).toContain('reverse charge');
    expect(note).toContain('arricurdai recall "<words>"');
  });

  it('after a compaction, tells the agent how to look up what the summary left out', () => {
    const out: string[] = [];
    runHandoff(JSON.stringify({ session_id: 's', transcript_path: '/nowhere/s.jsonl', source: 'compact' }), { stdout: (text) => out.push(text), now: () => new Date(), stateDir: '/nowhere', recallCommand: 'arricurdai recall' });
    expect(out[0]).toContain('arricurdai recall \\"<words>\\"');
  });
});
