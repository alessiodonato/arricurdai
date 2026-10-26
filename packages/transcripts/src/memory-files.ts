import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type { DiskMemoryFile } from '@arricurdai/core';

export interface DiscoverOptions {
  /** The Claude Code config folder, which holds the user memory. */
  claudeDir: string;
  /** The project's transcript folder, which holds the auto memory in `memory/MEMORY.md`. */
  transcriptsDir?: string;
  /** Highest folder to look in for CLAUDE.md files. Defaults to the folder just below the filesystem root. */
  stopAt?: string;
}

/** Claude Code follows imports up to this depth. */
const MAX_IMPORT_DEPTH = 5;
/** Claude Code loads only the first lines of MEMORY.md. */
const AUTO_MEMORY_LINES = 200;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Files imported with `@path`, outside code spans and code blocks, resolved from the importing file's folder. */
function importsOf(content: string, folder: string): string[] {
  const imports: string[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const match of line.replace(/`[^`]*`/g, ' ').matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-][\w./-]*)/g)) {
      const path = match[1]!.replace(/[.,;:]+$/, '');
      imports.push(path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(folder, path));
    }
  }
  return imports;
}

/** A rule with `paths:` in its front matter loads only when the agent works on those paths. */
function hasPathsFrontMatter(content: string): boolean {
  if (!content.startsWith('---\n')) return false;
  const end = content.indexOf('\n---', 4);
  return end > 0 && /^paths\s*:/m.test(content.slice(4, end));
}

/** Markdown files under `.claude/rules`, except the ones limited to some paths. */
function unconditionalRules(folder: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(folder, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => join(folder, entry))
    .filter((file) => isFile(file) && !hasPathsFrontMatter(readFileSync(file, 'utf8')));
}

/**
 * The memory files Claude Code loads at the start of a session in `projectRoot`, read from disk now.
 *
 * Only used for transcripts that do not record their memory. The order follows what Claude Code
 * 2.1.310 records: user memory, CLAUDE.md from the top folder down (each followed by its imports),
 * `.claude/CLAUDE.md`, `.claude/rules/*.md`, CLAUDE.local.md, then the first 200 lines of MEMORY.md.
 */
export function discoverMemoryFiles(projectRoot: string, options: DiscoverOptions): DiskMemoryFile[] {
  const files: DiskMemoryFile[] = [];
  const seen = new Set<string>();
  const add = (path: string, type: string, depth = 0): void => {
    if (seen.has(path) || !isFile(path)) return;
    seen.add(path);
    const content = readFileSync(path, 'utf8').replace(/\n$/, '');
    files.push({ path, type, content });
    if (depth < MAX_IMPORT_DEPTH) for (const imported of importsOf(content, dirname(path))) add(imported, type, depth + 1);
  };

  const root = resolve(projectRoot);
  const stop = options.stopAt === undefined ? undefined : resolve(options.stopAt);
  const folders: string[] = [];
  for (let folder = root; folder !== parse(folder).root; folder = dirname(folder)) {
    folders.unshift(folder);
    if (folder === stop) break;
  }

  add(join(options.claudeDir, 'CLAUDE.md'), 'User');
  for (const folder of folders) add(join(folder, 'CLAUDE.md'), 'Project');
  add(join(root, '.claude', 'CLAUDE.md'), 'Project');
  for (const rule of unconditionalRules(join(root, '.claude', 'rules'))) add(rule, 'Project');
  for (const folder of folders) add(join(folder, 'CLAUDE.local.md'), 'Local');

  const autoMemory = options.transcriptsDir === undefined ? undefined : join(options.transcriptsDir, 'memory', 'MEMORY.md');
  if (autoMemory !== undefined && isFile(autoMemory)) {
    const lines = readFileSync(autoMemory, 'utf8').replace(/\n$/, '').split('\n');
    files.push({ path: autoMemory, type: 'AutoMem', content: lines.slice(0, AUTO_MEMORY_LINES).join('\n') });
  }
  return files;
}
