import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardMessage, handoffNote, lastCall, prepareHandoff, runGuard, runHandoff } from '../src/guard';

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
  return { out, io, prompt, start, dir };
}

/** What the handoff hook prints after a /clear that follows a stopped prompt. */
interface Printed {
  systemMessage?: string;
  hookSpecificOutput: { additionalContext: string };
}

/** The hook input of a prompt sent to the old session. */
const stop = (dir: string, session: string, text: string): string =>
  JSON.stringify({ session_id: session, transcript_path: join(dir, 'old.jsonl'), cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: text });

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

  it('says, while the prompt is still on the screen, that the note after /clear will hold it', () => {
    const lines = guardMessage(call, 2 * HOUR, 100_000)!.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('Run /clear to start a new session: arricurdai will give it a note on this one, with this prompt in it. Tell Claude there to go on with it. Or send the prompt again to go on here.');
  });

  it('knows the price of the other models', () => {
    // 300,000 tokens × 2 × $8 per million for Claude Fable 5.2, and × $0.10 for Claude Haiku 5.5.
    expect(guardMessage({ ...call, model: 'claude-fable-5-2' }, 2 * HOUR, 100_000)).toContain('about $4.80');
    expect(guardMessage({ ...call, model: 'claude-haiku-5-5' }, 2 * HOUR, 100_000)).toContain('about $0.06');
    expect(guardMessage({ ...call, model: 'claude-next-9' }, 2 * HOUR, 100_000)).not.toContain('$');
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

  it('forgets the stopped prompt when it is sent again after a call the session made by itself', () => {
    const { out, io, start, dir } = setup();
    runGuard(stop(dir, 'old', 'Now write the tests of the retry.'), {}, io('2026-10-26T12:00:00Z'));
    expect(out).toHaveLength(1);
    // A task in the background ends: the session makes a call, and its cache lives again.
    appendFileSync(join(dir, 'old.jsonl'), `${assistant('2026-10-26T12:00:30Z', big, [{ type: 'text', text: 'The build is done.' }])}\n`);
    runGuard(stop(dir, 'old', 'Now write the tests of the retry.'), {}, io('2026-10-26T12:01:00Z'));
    // It went through, so it is not waiting for a /clear: the next one has no note that calls it never sent.
    runHandoff(start('clear'), io('2026-10-26T12:05:00Z'));
    expect(out).toHaveLength(1);
  });

  it('keeps the stopped prompt of a session when another session of the project goes on', () => {
    const { out, io, start, dir } = setup();
    // The other session is in use: its prompt goes through.
    writeFileSync(join(dir, 'other.jsonl'), `${[user('2026-10-26T11:58:00Z', 'Rename the upload client'), assistant('2026-10-26T11:59:00Z', big, [{ type: 'text', text: 'Renamed.' }])].join('\n')}\n`);
    runGuard(stop(dir, 'old', 'Now write the tests of the retry.'), {}, io('2026-10-26T12:00:00Z'));
    runGuard(JSON.stringify({ session_id: 'other', transcript_path: join(dir, 'other.jsonl'), cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: 'thanks' }), {}, io('2026-10-26T12:00:30Z'));
    expect(out).toHaveLength(1);
    runHandoff(start('clear'), io('2026-10-26T12:01:00Z'));
    expect((JSON.parse(out[1]!) as Printed).hookSpecificOutput.additionalContext).toContain('It was never sent: act on it only when the user tells you to go on with it.\nNow write the tests of the retry.');
  });

  it('keeps the prompt stopped last in the project when a session stopped before it sends its own again', () => {
    const { out, io, start, dir } = setup();
    writeFileSync(join(dir, 'other.jsonl'), `${[user('2026-10-26T09:10:00Z', 'Rename the upload client'), assistant('2026-10-26T09:11:00Z', big, [{ type: 'text', text: 'Renamed.' }])].join('\n')}\n`);
    runGuard(stop(dir, 'old', 'Now write the tests of the retry.'), {}, io('2026-10-26T12:00:00Z'));
    runGuard(JSON.stringify({ session_id: 'other', transcript_path: join(dir, 'other.jsonl'), cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: 'Rename it in the tests too.' }), {}, io('2026-10-26T12:00:10Z'));
    runGuard(stop(dir, 'old', 'Now write the tests of the retry.'), {}, io('2026-10-26T12:00:20Z'));
    expect(out).toHaveLength(2);
    runHandoff(start('clear'), io('2026-10-26T12:01:00Z'));
    const note = (JSON.parse(out[2]!) as Printed).hookSpecificOutput.additionalContext;
    expect(note).toContain('Last reply of the assistant:\nRenamed.');
    expect(note).toContain('It was never sent: act on it only when the user tells you to go on with it.\nRename it in the tests too.');
  });

  it('does nothing on a start that is not a /clear, or on input it cannot read', () => {
    const { out, io, prompt, start } = setup();
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    runHandoff(start('startup'), io('2026-10-26T12:01:00Z'));
    expect(runGuard('not json', {}, io('2026-10-26T12:00:00Z'))).toBe(0);
    expect(out).toHaveLength(1);
  });

  it('gives the stopped prompt after /clear: to the new session as not sent yet, and in a message for the user', () => {
    const { out, io, start, dir } = setup();
    const text = 'Add a retry to the upload client of the reports too.\nUse Password: Example2026 on staging.';
    runGuard(stop(dir, 'old', text), {}, io('2026-10-26T12:00:00Z'));
    runHandoff(start('clear'), io('2026-10-26T12:01:00Z'));
    const printed = JSON.parse(out[1]!) as Printed;
    const note = printed.hookSpecificOutput.additionalContext;
    const hidden = 'Add a retry to the upload client of the reports too.\nUse Password: [redacted] on staging.';
    expect(note).toContain(`It was never sent: act on it only when the user tells you to go on with it.\n${hidden}`);
    expect(printed.systemMessage).toBe(`arricurdai: the prompt that was stopped is in the note this session got. Tell Claude to go on with it, or send another prompt.\n\n${hidden}`);
    expect(JSON.stringify(printed)).not.toContain('Example2026');
    // After the note on the old session.
    expect(note.indexOf('It was never sent')).toBeGreaterThan(note.indexOf('Last reply of the assistant:'));
    // It fits in the note: no file.
    expect(readdirSync(join(dir, 'state')).filter((name) => name.startsWith('stopped-'))).toEqual([]);
  });

  it('keeps a stopped prompt too long for the note whole in a file, with its start in the note', () => {
    const { out, io, start, dir } = setup();
    const text = `Add a retry to the upload client, as this log asks.\n${'one line of the log\n'.repeat(1_000)}`.trim();
    runGuard(stop(dir, 'old', text), {}, io('2026-10-26T12:00:00Z'));
    runHandoff(start('clear'), { ...io('2026-10-26T12:01:00Z'), recallCommand: 'arricurdai recall' });
    const printed = JSON.parse(out[1]!) as Printed;
    const note = printed.hookSpecificOutput.additionalContext;
    const files = (): string[] => readdirSync(join(dir, 'state')).filter((name) => name.startsWith('stopped-'));
    const file = join(dir, 'state', files()[0]!);
    expect(readFileSync(file, 'utf8')).toBe(text);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(note).toContain(`It is 20,051 characters long: this is its start, and the whole of it is in ${file}. Read that file before you act on it.\nAdd a retry to the upload client, as this log asks.\none line of the log`);
    expect(printed.systemMessage).toContain(`It is 20,051 characters long: this is its start, and the whole of it is in ${file}\n\nAdd a retry to the upload client, as this log asks.`);
    // Claude Code cuts a longer text to a preview: the start of the prompt takes the room that is left.
    expect(note.length).toBeLessThanOrEqual(10_000);
    expect(note.length).toBeGreaterThan(9_900);
    expect(printed.systemMessage!.length).toBeLessThanOrEqual(10_000);
    expect(note.endsWith('run: arricurdai recall "<words>"')).toBe(true);

    // The next prompt stopped in the project fits in the note: the file goes.
    runGuard(stop(dir, 'later', 'go on'), {}, io('2026-10-26T12:02:00Z'));
    runHandoff(start('clear'), io('2026-10-26T12:03:00Z'));
    expect((JSON.parse(out[3]!) as Printed).systemMessage).toContain('\n\ngo on');
    expect(files()).toEqual([]);
  });
});

// Owners and modes of files, as on Linux and macOS.
describe.skipIf(process.platform === 'win32')('the state folder', () => {
  it('is made for this user only, and so are the files in it', () => {
    const { io, prompt, dir } = setup();
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    const state = join(dir, 'state');
    expect(statSync(state).mode & 0o777).toBe(0o700);
    const files = readdirSync(state);
    expect(files).toHaveLength(2);
    expect(files.map((name) => statSync(join(state, name)).mode & 0o777)).toEqual([0o600, 0o600]);
  });

  it('closes a folder of this user that was left open to the others, and goes on', () => {
    const { out, io, prompt, dir } = setup();
    mkdirSync(join(dir, 'state'));
    chmodSync(join(dir, 'state'), 0o755);
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: 'block' });
  });

  it('lets the prompt through when the folder is a link to somewhere else', () => {
    const { out, io, prompt, dir } = setup();
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'state'));
    expect(runGuard(prompt, {}, io('2026-10-26T12:00:00Z'))).toBe(0);
    expect(out).toHaveLength(0);
    expect(readdirSync(join(dir, 'elsewhere'))).toHaveLength(0);
  });

  it('gives no note from a folder that others can write', () => {
    const { out, io, prompt, start, dir } = setup();
    runGuard(prompt, {}, io('2026-10-26T12:00:00Z'));
    chmodSync(join(dir, 'state'), 0o777);
    runHandoff(start('clear'), io('2026-10-26T12:01:00Z'));
    expect(out).toHaveLength(1);
  });
});

describe('handoff --prepare', () => {
  it('a tool asks for the note, and the session started with /clear in the same project gets it', () => {
    const { out, io, start, dir } = setup();
    expect(prepareHandoff(join(dir, 'old.jsonl'), io('2026-10-26T12:00:00Z'))).toEqual({ ok: true });
    expect(out).toEqual([]);
    runHandoff(start('clear'), io('2026-10-26T12:00:05Z'));
    expect(out).toHaveLength(1);
    const context = JSON.parse(out[0]!).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('Add a retry to the upload client');
    expect(context).toContain('Files changed: src/upload.ts');
    expect(context).toContain('Retry added; tests are next.');
    expect(context).toContain('300,002 tokens');
    // No prompt was stopped: no earlier context that matches one, and nothing to give back.
    expect(context).not.toContain('Earlier context that matches');
    expect(context).not.toContain('never sent');
    expect(JSON.parse(out[0]!)).not.toHaveProperty('systemMessage');
    // Given once: the next /clear has no note.
    runHandoff(start('clear'), io('2026-10-26T12:00:10Z'));
    expect(out).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('writes the marker the guard writes, with no prompt, for the user alone', () => {
    const { io, dir } = setup();
    prepareHandoff(join(dir, 'old.jsonl'), io('2026-10-26T12:00:00Z'));
    const [name] = readdirSync(join(dir, 'state'));
    expect(name).toMatch(/^handoff-.*\.json$/);
    expect(statSync(join(dir, 'state', name!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'state', name!), 'utf8'))).toEqual({ transcript: join(dir, 'old.jsonl'), context: 300_002, at: Date.parse('2026-10-26T12:00:00Z') });
  });

  it('keeps the prompt the guard has just stopped in that session, and not one of another session or of long ago', () => {
    const { out, io, start, dir } = setup();
    const context = (index: number): string => (JSON.parse(out[index]!) as Printed).hookSpecificOutput.additionalContext;
    runGuard(stop(dir, 'old', 'Now write the tests of the retry.'), {}, io('2026-10-26T12:00:00Z'));
    expect(prepareHandoff(join(dir, 'old.jsonl'), io('2026-10-26T12:00:20Z'))).toEqual({ ok: true });
    runHandoff(start('clear'), io('2026-10-26T12:00:25Z'));
    expect(context(1)).toContain('It was never sent: act on it only when the user tells you to go on with it.\nNow write the tests of the retry.');
    expect((JSON.parse(out[1]!) as Printed).systemMessage).toContain('\n\nNow write the tests of the retry.');

    // Another session of the project: the prompt stopped in the first one is not its own.
    writeFileSync(join(dir, 'other.jsonl'), `${session.join('\n')}\n`);
    runGuard(stop(dir, 'again', 'Now write the tests of the retry.'), {}, io('2026-10-26T13:00:00Z'));
    prepareHandoff(join(dir, 'other.jsonl'), io('2026-10-26T13:00:20Z'));
    runHandoff(start('clear'), io('2026-10-26T13:00:25Z'));
    expect(context(3)).not.toContain('never sent');

    // Stopped more than twelve hours before: the note is new, the prompt is not given.
    runGuard(stop(dir, 'once more', 'Now write the tests of the retry.'), {}, io('2026-10-27T00:00:00Z'));
    prepareHandoff(join(dir, 'old.jsonl'), io('2026-10-27T13:00:00Z'));
    runHandoff(start('clear'), io('2026-10-27T13:00:05Z'));
    expect(context(5)).toContain('Retry added; tests are next.');
    expect(context(5)).not.toContain('never sent');
  });

  it('says why when the transcript is not there, and writes nothing', () => {
    const { io, dir } = setup();
    expect(prepareHandoff(join(dir, 'missing.jsonl'), io('2026-10-26T12:00:00Z'))).toEqual({ ok: false, error: `no transcript at ${join(dir, 'missing.jsonl')}` });
    expect(readdirSync(dir)).not.toContain('state');
  });

  it('a note asked too long ago is not given, as after the guard', () => {
    const { out, io, start, dir } = setup();
    expect(prepareHandoff(join(dir, 'old.jsonl'), io('2026-10-26T00:00:00Z'))).toEqual({ ok: true });
    // Thirteen hours later: the marker is older than the twelve it lasts.
    runHandoff(start('clear'), io('2026-10-26T13:00:00Z'));
    expect(out).toEqual([]);
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
