import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGuard, runHandoff } from '../src/guard';
import { formatHits, redact, runRecall, search, sessionChunks, terms } from '../src/recall';

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

  it('shows the line that holds the rarest words of the query, not the one that repeats a common word', () => {
    const filler = Array.from({ length: 20 }, () => 'More notes on the build, written after the last deploy.');
    const long = { sessionId: 's1', timestamp: '2026-10-01T09:00:00Z', request: 'Check staging', text: ['Check staging: staging deploy, staging logs, staging users.', ...filler, 'Brevo sends from noreply on staging.'].join('\n') };
    const others = ['staging is up', 'staging again', 'staging is slow'].map((text, index) => ({ sessionId: `s${index + 2}`, timestamp: '2026-10-02T09:00:00Z', request: text, text }));
    const [first] = search([long, ...others], 'brevo staging', 1);
    expect(first?.chunk).toBe(long);
    expect(first?.excerpt).toContain('Brevo sends from noreply');
    expect(first?.coverage).toBe(1);
  });

  it('with a minimum coverage, leaves out a chunk whose excerpt holds too little of the query', () => {
    const filler = Array.from({ length: 20 }, () => 'Notes on the invoices and the reports of the month.');
    const scattered = { sessionId: 's1', timestamp: '2026-10-01T09:00:00Z', request: 'Brevo setup', text: ['Brevo setup', ...filler, 'The sender is in mittente.ts'].join('\n') };
    const together = { sessionId: 's2', timestamp: '2026-10-02T09:00:00Z', request: 'Brevo', text: 'Brevo: il mittente è noreply.' };
    const all = search([scattered, together], 'brevo mittente', 2);
    expect(all).toHaveLength(2);
    expect(all.find((hit) => hit.chunk === scattered)!.coverage).toBeLessThan(0.9);
    expect(search([scattered, together], 'brevo mittente', 2, 0.9).map((hit) => hit.chunk)).toEqual([together]);
  });
});

describe('redact', () => {
  it('hides keys and tokens, passwords in URLs and the values given to keys that name a secret', () => {
    const secrets = [
      'BREVO_API_KEY=xkeysib-example-0000-not-a-real-key',
      'export ANTHROPIC_API_KEY=sk-ant-example-0000-not-a-real-key',
      'DATABASE_URL=postgresql://postgres:Qw7Er8Ty9@db.example.com:5432/railway',
      '| `SESSION_SECRET` | `4f9a8b7c6d5e4f3a2b1c` |',
      '**Password:** `Palestra2026`',
      'la password provvisoria è Bosco-12x',
      'SESSION_SECRET="Zq8-Wx7_Vb6"',
      "SECRET_KEY = 'django-insecure-k3y'",
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXBhcnQ',
      '- test: `coach@example.com` / `Rb7Kd2mX`',
      'la pw del coach è Xyz-123',
      'le password generate sono: `Kx7pQ2zw`, `Wm4tR9ex`',
      'accesso coach: `coach@example.com`, password `Hq5vN8rT2w`',
      'entra e cambia la password — `Zt8Lp3Qw`',
    ];
    for (const line of secrets) expect(redact(line)).toContain('[redacted]');
    expect(redact(secrets.join('\n'))).not.toMatch(/xkeysib|sk-ant|Qw7Er8Ty9|4f9a8b7c|Palestra2026|Bosco-12x|eyJhbGci|Zq8-Wx7|django-insecure|Rb7Kd2mX|Xyz-123|Kx7pQ2zw|Wm4tR9ex|Hq5vN8rT2w|Zt8Lp3Qw/);
    expect(redact('accesso coach: `coach@example.com`, password `Hq5vN8rT2w`')).toContain('`coach@example.com`');
    expect(redact(secrets[2]!)).toBe('DATABASE_URL=postgresql://postgres:[redacted]@db.example.com:5432/railway');
  });

  it('leaves alone words, numbers, references and code', () => {
    const plain = [
      'Ho la password dimenticata: la reimposto dal pannello.',
      '| `DATABASE_URL` | riferimento al Postgres interno, via rete privata |',
      'DATABASE_URL=${{Postgres.DATABASE_URL}} e SESSION_SECRET=${{shared.SESSION_SECRET}}',
      'postgresql://postgres@localhost:5435/postgres',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 e MAX_TOKENS=150000',
      'const API_KEY = process.env.API_KEY; password: hashedPassword; SESSION_SECRET: z.string().min(32)',
      'session 93f3a212, commit 8ef8ce2, coach@example.com',
      'DATABASE_URL="file:./dev.db" EMAIL_API_KEY= APP_URL=http://localhost:3000 pnpm dev',
      'milioni di token pesati: 2.586.755 e `SESSION_SECRET`: Generato da Railway',
      'scrivi a marta@example.com / coach@example.com, ruolo marta@example.com / coach',
      'la password si salva con `bcrypt` in `passwordHash`, e `SESSION_SECRET` sta in `lib/auth.ts`',
      'password reimpostata con `pnpm db:seed`',
      'per la password usa `node:crypto`, il cookie `crabs_session`, lo scope `write_packages`, il filtro `variant=nuovo` e il commit `a1b2c3d`',
      'Password aggiornata e Marta è entrata. Al login compare «Questa password è sbagliata».',
    ];
    for (const line of plain) expect(redact(line)).toBe(line);
  });

  it('keeps secrets out of what recall prints, even where a long request is cut', () => {
    const request = `${'Configura le variabili su Railway e ricontrolla. '.repeat(2)}SESSION_SECRET=9f8e7d6c5b4a39281706f5e4d3c2b1a0`;
    const [hit] = search([{ sessionId: 's1', timestamp: '2026-10-01T09:00:00Z', request, text: `${request}\nPassword: Palestra2026` }], 'password railway', 1);
    const text = formatHits([hit!], 'password railway', 1, 1_500);
    expect(text).toContain('Password: [redacted]');
    expect(text).not.toMatch(/9f8e7|Palestra2026/);
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

  it('leaves out the earlier context when it matches the stopped prompt only loosely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arricurdai-recall-'));
    writeFileSync(join(dir, 'old.jsonl'), older.join('\n'));
    const big = { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 299_000, cache_creation: { ephemeral_1h_input_tokens: 1_000 } };
    const last = join(dir, 'last.jsonl');
    writeFileSync(last, [user('2026-10-25T09:00:00Z', 'Refactor the invoice module'), assistant('2026-10-25T09:05:00Z', [{ type: 'text', text: 'Refactor done.' }], big)].join('\n'));
    const out: string[] = [];
    const io = (at: string) => ({ stdout: (text: string) => out.push(text), now: () => new Date(at), stateDir: join(dir, 'state'), recallCommand: 'arricurdai recall' });

    runGuard(JSON.stringify({ session_id: 'last', transcript_path: last, cwd: '/repo', prompt: 'Plan the calendar sync with Google and the push notifications for the invoices' }), {}, io('2026-10-26T12:00:00Z'));
    runHandoff(JSON.stringify({ session_id: 'new', transcript_path: join(dir, 'new.jsonl'), cwd: '/repo', source: 'clear' }), io('2026-10-26T12:01:00Z'));

    const note = (JSON.parse(out[1]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(note).toContain('Note from arricurdai on the previous session');
    expect(note).not.toContain('Earlier context');
  });

  it('after a compaction, tells the agent how to look up what the summary left out', () => {
    const out: string[] = [];
    runHandoff(JSON.stringify({ session_id: 's', transcript_path: '/nowhere/s.jsonl', source: 'compact' }), { stdout: (text) => out.push(text), now: () => new Date(), stateDir: '/nowhere', recallCommand: 'arricurdai recall' });
    expect(out[0]).toContain('arricurdai recall \\"<words>\\"');
  });
});
