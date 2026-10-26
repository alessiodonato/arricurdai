import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitHistory {
  /** Whether a path, relative to the project folder, changed in a commit after `since` and up to `until`. */
  changedBetween(path: string, since: string, until: string): boolean | undefined;
}

const GLOB = /[*?[]/;

/** Turns a shell glob into a regular expression over whole paths: `*` stays within a folder, `**` crosses folders. */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i++;
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Reads, with one `git log`, which files under `projectDir` changed in each commit since `since`.
 * The answers are the same as `git log --since <t1> --until <t2> -- <file>` for each file.
 *
 * Returns undefined when `projectDir` is not in a git work tree, or git is not installed.
 */
export async function loadGitHistory(projectDir: string, since?: string): Promise<GitHistory | undefined> {
  try {
    await run('git', ['-C', projectDir, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return undefined;
  }

  const commits = new Map<string, number[]>();
  try {
    const args = ['-C', projectDir, 'log', '--relative', '--name-only', '--no-renames', '--format=%x1e%ct'];
    if (since !== undefined) args.push(`--since=${since}`);
    const { stdout } = await run('git', [...args, '--', '.'], { maxBuffer: 512 * 1024 * 1024 });
    for (const record of stdout.split('\x1e')) {
      const [time, ...names] = record.split('\n');
      const seconds = Number(time);
      if (!time || !Number.isFinite(seconds)) continue;
      for (const name of names) {
        if (!name) continue;
        const times = commits.get(name);
        if (times) times.push(seconds);
        else commits.set(name, [seconds]);
      }
    }
  } catch {
    // A repository with no commits has no history to read.
  }

  return {
    changedBetween(path, since, until) {
      if (path.startsWith('/') || path.startsWith('~') || path.startsWith('..')) return undefined;
      const from = Date.parse(since) / 1000;
      const to = Date.parse(until) / 1000;
      if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
      const inRange = (times: number[] | undefined): boolean => (times ?? []).some((time) => time > from && time <= to);
      const normalized = posix.normalize(path);
      if (!GLOB.test(normalized)) return inRange(commits.get(normalized));
      const matcher = globToRegExp(normalized);
      return [...commits].some(([name, times]) => matcher.test(name) && inRange(times));
    },
  };
}
