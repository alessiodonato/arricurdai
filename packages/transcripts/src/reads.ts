import { posix } from 'node:path';
import { analyzeBash, type RawRead, type ReadKind, resolvePath } from './shell';

/** A read of context, with paths relative to the project root. */
export interface ReadTarget {
  /** `Read`, `Grep`, `Glob`, or the Bash program that read (`cat`, `grep`, `find`, …). */
  tool: string;
  kind: ReadKind;
  /** file: the path. search: the pattern. list: the folders listed. */
  target: string;
  /** search: the folders or files searched. */
  scope?: string;
  /** search and list: globs, types or find expression that narrow the result. */
  filter?: string;
}

export interface FileChangeTarget {
  /** Relative to the project root, or absolute when outside it. */
  path: string;
  tool: string;
}

export interface ToolCallEffects {
  reads: ReadTarget[];
  changes: FileChangeTarget[];
}

/** Path relative to `root`, or unchanged when it is outside `root`. */
export function relativeToRoot(path: string, root: string): string {
  if (!path.startsWith('/')) return path;
  if (path === root) return '.';
  const relative = posix.relative(root, path);
  return relative.startsWith('..') ? path : relative;
}

/** Key that identifies the same read across sessions. */
export function readKey(read: Pick<ReadTarget, 'kind' | 'target' | 'scope' | 'filter'>): string {
  const filter = read.filter ? ` [${read.filter}]` : '';
  if (read.kind === 'search') return `search:${read.target} @ ${read.scope ?? '.'}${filter}`;
  return `${read.kind}:${read.target}${read.kind === 'list' ? filter : ''}`;
}

function normalize(raw: RawRead, root: string): ReadTarget {
  const paths = raw.paths.map((path) => relativeToRoot(path, root));
  const filter = raw.filter ? { filter: raw.filter } : {};
  if (raw.kind === 'search') return { tool: raw.tool, kind: 'search', target: raw.pattern ?? '', scope: paths.join(' '), ...filter };
  return { tool: raw.tool, kind: raw.kind, target: paths.join(' '), ...filter };
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * What a tool call read and which files it changed.
 *
 * Reads come from `Read`, `Grep`, `Glob` and read-only `Bash` commands. Changes come from `Edit`,
 * `MultiEdit`, `Write`, `NotebookEdit` and Bash commands that write files.
 *
 * @param cwd Absolute folder the call ran in.
 * @param root Absolute project root that paths are made relative to.
 */
export function classifyToolCall(name: string, input: Record<string, unknown>, cwd: string, root: string): ToolCallEffects {
  const resolve = (path: string): string => relativeToRoot(resolvePath(cwd, path), root);
  switch (name) {
    case 'Read': {
      const file = text(input.file_path);
      return { reads: file ? [{ tool: 'Read', kind: 'file', target: resolve(file) }] : [], changes: [] };
    }
    case 'Grep': {
      const pattern = text(input.pattern);
      if (!pattern) return { reads: [], changes: [] };
      const filter = [text(input.glob), text(input.type) && `type:${String(input.type)}`].filter(Boolean).join(' ');
      return {
        reads: [{ tool: 'Grep', kind: 'search', target: pattern, scope: resolve(text(input.path) ?? cwd), ...(filter ? { filter } : {}) }],
        changes: [],
      };
    }
    case 'Glob': {
      const pattern = text(input.pattern);
      if (!pattern) return { reads: [], changes: [] };
      return { reads: [{ tool: 'Glob', kind: 'list', target: resolve(text(input.path) ?? cwd), filter: pattern }], changes: [] };
    }
    case 'Bash': {
      const command = text(input.command);
      if (!command) return { reads: [], changes: [] };
      const analysis = analyzeBash(command, cwd);
      return {
        reads: analysis.reads.map((read) => normalize(read, root)),
        changes: analysis.writes.map((path) => ({ path: relativeToRoot(path, root), tool: 'Bash' })),
      };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const file = text(input.file_path);
      return { reads: [], changes: file ? [{ path: resolve(file), tool: name }] : [] };
    }
    case 'NotebookEdit': {
      const file = text(input.notebook_path);
      return { reads: [], changes: file ? [{ path: resolve(file), tool: name }] : [] };
    }
    default:
      return { reads: [], changes: [] };
  }
}
