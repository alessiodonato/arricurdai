import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSetup, type SetupIO } from '../src/setup';

const bin = '/opt/tools/lib/node_modules/arricurdai/dist/bin.js';
const guard = `node "${bin}" guard`;
const handoff = `node "${bin}" handoff`;

function fixture(settings?: string): { dir: string; file: string; out: () => string; io: (overrides?: Partial<SetupIO>) => SetupIO } {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-setup-'));
  const file = join(dir, 'settings.json');
  if (settings !== undefined) writeFileSync(file, settings);
  let text = '';
  const io = (overrides: Partial<SetupIO> = {}): SetupIO => ({
    cwd: dir,
    env: { CLAUDE_CONFIG_DIR: dir },
    stdout: (chunk) => { text += chunk; },
    stderr: (chunk) => { text += chunk; },
    now: () => new Date('2026-11-06T12:00:00Z'),
    colors: false,
    bin,
    confirm: async () => true,
    ...overrides,
  });
  return { dir, file, out: () => text, io };
}

const read = (file: string): Record<string, any> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
const commands = (settings: Record<string, any>, event: string): string[] =>
  (settings.hooks?.[event] ?? []).flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));

describe('setup', () => {
  it('adds both hooks to a new file', async () => {
    const { file, io, out } = fixture();
    expect(await runSetup({}, io())).toBe(0);
    const settings = read(file);
    expect(commands(settings, 'UserPromptSubmit')).toEqual([guard]);
    expect(commands(settings, 'SessionStart')).toEqual([handoff]);
    expect(out()).toContain('setup --remove');
  });

  it('keeps every other setting and every other hook', async () => {
    const { file, io } = fixture(JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }], Stop: [{ hooks: [{ type: 'command', command: 'bell' }] }] },
    }));
    await runSetup({}, io());
    const settings = read(file);
    expect(settings.theme).toBe('dark');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(commands(settings, 'UserPromptSubmit')).toEqual(['my-own-hook', guard]);
    expect(commands(settings, 'Stop')).toEqual(['bell']);
  });

  it('shows the changes and asks before writing, and a no leaves the file as it is', async () => {
    const before = '{ "theme":   "dark" }\n';
    const { file, io, out } = fixture(before);
    let asked = '';
    expect(await runSetup({}, io({ confirm: async (question) => { asked = question; return false; } }))).toBe(0);
    expect(asked).not.toBe('');
    expect(out()).toContain(guard);
    expect(out()).toContain(handoff);
    expect(out()).toContain('Nothing changed');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(`${file}.arricurdai-backup`)).toBe(false);
  });

  it('with --yes it does not ask', async () => {
    const { file, io } = fixture();
    await runSetup({ yes: true }, io({ confirm: async () => { throw new Error('asked'); } }));
    expect(commands(read(file), 'SessionStart')).toEqual([handoff]);
  });

  it('changes nothing when the hooks are already there', async () => {
    const before = `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: guard }] }], SessionStart: [{ hooks: [{ type: 'command', command: handoff }] }] } })}\n`;
    const { file, io, out } = fixture(before);
    expect(await runSetup({}, io({ confirm: async () => { throw new Error('asked'); } }))).toBe(0);
    expect(out()).toContain('already');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(`${file}.arricurdai-backup`)).toBe(false);
  });

  it('moves hooks of an older install to this one, and keeps their options', async () => {
    const { file, io } = fixture(JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /home/me/code/arricurdAI/packages/cli/dist/bin.js guard --min-tokens 50000' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'npx arricurdai handoff' }] }],
    } }));
    await runSetup({}, io());
    const settings = read(file);
    expect(commands(settings, 'UserPromptSubmit')).toEqual([`${guard} --min-tokens 50000`]);
    expect(commands(settings, 'SessionStart')).toEqual([handoff]);
  });

  it('does not take the hook of another tool for its own', async () => {
    const other = 'node /home/me/arricurdai-lab/other-tool.js guard';
    const { file, io } = fixture(JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: other }] }] } }));
    await runSetup({}, io());
    expect(commands(read(file), 'UserPromptSubmit')).toEqual([other, guard]);
  });

  it('keeps a copy of the old file, with its permissions', async () => {
    const before = '{ "env": { "SOME_VALUE": "kept" } }\n';
    const { file, io } = fixture(before);
    chmodSync(file, 0o600);
    await runSetup({}, io());
    expect(readFileSync(`${file}.arricurdai-backup`, 'utf8')).toBe(before);
    expect(statSync(`${file}.arricurdai-backup`).mode & 0o777).toBe(0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes through a symbolic link instead of replacing it', async () => {
    const { dir, io } = fixture();
    const real = join(mkdtempSync(join(tmpdir(), 'arricurdai-dotfiles-')), 'settings.json');
    writeFileSync(real, '{}\n');
    symlinkSync(real, join(dir, 'settings.json'));
    await runSetup({}, io());
    expect(lstatSync(join(dir, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(commands(read(real), 'SessionStart')).toEqual([handoff]);
  });

  it('touches nothing when the file is not valid JSON', async () => {
    const before = '{ "theme": "dark", // a comment\n}';
    const { file, io, out } = fixture(before);
    expect(await runSetup({}, io())).toBe(1);
    expect(out()).toContain('not valid JSON');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('touches nothing when the hooks have an unexpected shape', async () => {
    const before = '{ "hooks": { "SessionStart": "not a list" } }';
    const { file, io } = fixture(before);
    expect(await runSetup({}, io())).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('touches nothing when the file changes while it waits for the answer', async () => {
    const { file, io, out } = fixture('{ "theme": "dark" }\n');
    const changed = '{ "theme": "light" }\n';
    const code = await runSetup({}, io({ confirm: async () => { writeFileSync(file, changed); return true; } }));
    expect(code).toBe(1);
    expect(out()).toContain('changed');
    expect(readFileSync(file, 'utf8')).toBe(changed);
  });

  it.each([
    '/home/me/.npm/_npx/0123abcd/node_modules/arricurdai/dist/bin.js',
    '/home/me/.cache/pnpm/dlx/0123abcd/node_modules/arricurdai/dist/bin.js',
    '/tmp/bunx-501-arricurdai@latest/node_modules/arricurdai/dist/bin.js',
  ])('refuses a copy that can disappear: %s', async (temporary) => {
    const { file, io, out } = fixture('{}\n');
    expect(await runSetup({}, io({ bin: temporary }))).toBe(1);
    expect(out()).toContain('npm install -g arricurdai');
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
  });

  it('with --project writes the local settings of that project only', async () => {
    const { dir, file, io } = fixture();
    const project = join(dir, 'shop');
    mkdirSync(project);
    await runSetup({ project: 'shop' }, io());
    expect(commands(read(join(project, '.claude', 'settings.local.json')), 'SessionStart')).toEqual([handoff]);
    expect(existsSync(file)).toBe(false);
  });

  it('with --remove takes out its own hooks only, from any install', async () => {
    const { file, io } = fixture(JSON.stringify({
      theme: 'dark',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook' }, { type: 'command', command: 'node /old/arricurdAI/packages/cli/dist/bin.js guard' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: handoff }] }],
      },
    }));
    expect(await runSetup({ remove: true }, io())).toBe(0);
    expect(read(file)).toEqual({ theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } });
  });

  it('after --remove leaves no empty hooks behind, and works from a temporary copy', async () => {
    const { file, io } = fixture(JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: handoff }] }] } }));
    expect(await runSetup({ remove: true }, io({ bin: '/home/me/.npm/_npx/0123abcd/node_modules/arricurdai/dist/bin.js' }))).toBe(0);
    expect(read(file)).toEqual({ theme: 'dark' });
  });

  it('with --remove and nothing to remove, says so', async () => {
    const { file, io, out } = fixture('{}\n');
    expect(await runSetup({ remove: true }, io())).toBe(0);
    expect(out()).toContain('no arricurdai hooks');
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
  });
});
