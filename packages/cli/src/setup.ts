import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { claudeConfigDir } from '@arricurdai/transcripts';
import type { CommandIO } from './run-profile';

// `arricurdai setup` turns the two hooks on in the Claude Code settings. It is the only command that changes a file of
// the user, so it shows the changes, asks first, keeps a copy, and touches nothing it does not fully understand.

export interface SetupOptions {
  project?: string;
  remove?: boolean;
  yes?: boolean;
}

export interface SetupIO extends CommandIO {
  /** This program, as the hooks will run it. */
  bin: string;
  confirm: (question: string) => Promise<boolean>;
}

const HOOKS = [
  { event: 'UserPromptSubmit', name: 'guard' },
  { event: 'SessionStart', name: 'handoff' },
] as const;

/** A hook of arricurdai from any install: a cloned bin.js, or the command by name. Holds the hook and its options. */
const OUR_HOOK = /(?:arricurdai[^\s"']*\/bin\.js|(?:^|[\s/])arricurdai)["']?\s+(guard|handoff)(\s.*)?$/i;
/** Copies that a package runner keeps in a cache: a hook that points there breaks when the cache is cleaned. */
const TEMPORARY = /[/\\](?:_npx|dlx(?:-[^/\\]+)?|bunx-[^/\\]+|xfs-[^/\\]+)[/\\]/;
const BACKUP_SUFFIX = '.arricurdai-backup';

type Json = Record<string, unknown>;
interface Group extends Json {
  hooks?: unknown;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

class Unexpected extends Error {}

function eventGroups(hooks: Json, event: string): Group[] {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups) || !groups.every(isObject)) throw new Unexpected(`its hooks for ${event} are not a list`);
  return groups as Group[];
}

/** The hooks of a group. Only a list of objects can be changed safely; anything else stops the command. */
function groupHooks(group: Group, event: string): Json[] {
  const hooks = group.hooks ?? [];
  if (!Array.isArray(hooks) || !hooks.every(isObject)) throw new Unexpected(`a hook group of ${event} has no list of hooks`);
  return hooks as Json[];
}

function hooksOf(settings: Json): Json {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new Unexpected('its hooks are not an object');
  return hooks;
}

const ownHook = (hook: Json): RegExpExecArray | null => (typeof hook.command === 'string' ? OUR_HOOK.exec(hook.command) : null);

/** The settings with both hooks in place, pointing at this install, and the lines that say what changed. */
function added(settings: Json, bin: string): { settings: Json; changes: string[] } {
  const next = structuredClone(settings);
  const hooks = hooksOf(next);
  const changes: string[] = [];
  for (const { event, name } of HOOKS) {
    const groups = eventGroups(hooks, event);
    const wanted = `node "${bin}" ${name}`;
    const found = groups.flatMap((group) => groupHooks(group, event)).filter((hook) => ownHook(hook)?.[1] === name);
    for (const hook of found) {
      const command = `${wanted}${ownHook(hook)?.[2] ?? ''}`;
      if (hook.command === command) continue;
      changes.push(`  ~ ${event}: ${String(hook.command)}\n    now: ${command}`);
      hook.command = command;
    }
    if (found.length === 0) {
      hooks[event] = [...groups, { hooks: [{ type: 'command', command: wanted }] }];
      changes.push(`  + ${event}: ${wanted}`);
    }
  }
  next.hooks = hooks;
  return { settings: next, changes };
}

/** The settings without the hooks of arricurdai, and with no empty lists left where they were. */
function removed(settings: Json): { settings: Json; changes: string[] } {
  const next = structuredClone(settings);
  const hooks = hooksOf(next);
  const changes: string[] = [];
  for (const { event } of HOOKS) {
    if (hooks[event] === undefined) continue;
    const kept: Group[] = [];
    for (const group of eventGroups(hooks, event)) {
      const list = groupHooks(group, event);
      const others = list.filter((hook) => {
        if (!ownHook(hook)) return true;
        changes.push(`  - ${event}: ${String(hook.command)}`);
        return false;
      });
      if (others.length === list.length) kept.push(group);
      else if (others.length > 0) kept.push({ ...group, hooks: others });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return { settings: next, changes };
}

/** Writes the settings in one step, through a symbolic link if there is one, with the permissions of the old file. */
function write(file: string, settings: Json): string | undefined {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  const old = existsSync(target);
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (old) {
    copyFileSync(target, backup);
    chmodSync(backup, statSync(target).mode & 0o777);
  }
  const temporary = `${target}.arricurdai-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  if (old) chmodSync(temporary, statSync(target).mode & 0o777);
  renameSync(temporary, target);
  return old ? backup : undefined;
}

/** `arricurdai setup`: adds the hooks to the settings of Claude Code, or takes them out with --remove. */
export async function runSetup(options: SetupOptions, io: SetupIO): Promise<number> {
  const fail = (message: string): number => {
    io.stderr(`arricurdai: ${message}\n`);
    return 1;
  };
  if (!options.remove && TEMPORARY.test(io.bin)) {
    return fail(`this copy runs from a temporary folder, so the hooks would stop working when it is cleaned. Install it first: npm install -g arricurdai\nThen run: arricurdai setup\nNothing changed.`);
  }
  const file = options.project ? join(resolve(io.cwd, options.project), '.claude', 'settings.local.json') : join(claudeConfigDir(io.env), 'settings.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;

  let settings: unknown;
  try {
    settings = before === undefined || before.trim() === '' ? {} : JSON.parse(before);
  } catch {
    return fail(`${file} is not valid JSON, so it was left as it is. Fix it, then run this again.`);
  }
  if (!isObject(settings)) return fail(`${file} is not a JSON object, so it was left as it is.`);

  let plan: { settings: Json; changes: string[] };
  try {
    plan = options.remove ? removed(settings) : added(settings, io.bin);
  } catch (error) {
    if (error instanceof Unexpected) return fail(`${file} was left as it is: ${error.message}.`);
    throw error;
  }
  if (plan.changes.length === 0) {
    io.stdout(options.remove ? `arricurdai: no arricurdai hooks in ${file}.\n` : `arricurdai: the hooks are already in ${file}.\n`);
    return 0;
  }

  io.stdout(`arricurdai setup will change ${file}:\n\n${plan.changes.join('\n')}\n\n`);
  if (!options.yes && !(await io.confirm('Apply these changes? [y/N] '))) {
    io.stdout('Nothing changed. To apply them without being asked, add --yes.\n');
    return 0;
  }
  // The answer can take a while, and Claude Code writes to this file too.
  const now = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (now !== before) return fail(`${file} changed in the meantime, so it was left as it is. Run this again.`);

  const backup = write(file, plan.settings);
  const copy = backup ? ` A copy of the old file is in ${backup}.` : '';
  io.stdout(options.remove ? `Done: the hooks are off.${copy}\n` : `Done: the hooks apply to the Claude Code sessions you start from now on.${copy}\nTo turn them off: arricurdai setup --remove\n`);
  return 0;
}
