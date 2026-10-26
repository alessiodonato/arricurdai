import { posix } from 'node:path';
import type { ReadKind } from '@arricurdai/core';

type Token =
  | { type: 'word'; value: string }
  | { type: 'op'; value: '|' | '||' | '&&' | ';' | '&' }
  | { type: 'redirect'; value: string };

/** One command of a command line, with its arguments and redirects. */
export interface SimpleCommand {
  words: string[];
  redirects: { op: string; target: string }[];
  /** Operator that joins it to the previous command; `|` means its input comes from a pipe. */
  joinedBy: string | undefined;
}

/**
 * Splits a command line into words, operators and redirects, and removes quotes.
 * Returns undefined for constructs whose effect cannot be known without running them:
 * command and process substitution, heredocs, subshells and unbalanced quotes.
 */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  const endWord = (): void => {
    if (inWord) tokens.push({ type: 'word', value: word });
    word = '';
    inWord = false;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    const next = command[i + 1];
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\n') {
      endWord();
      tokens.push({ type: 'op', value: ';' });
      i++;
    } else if (c === '#' && !inWord) {
      while (i < command.length && command[i] !== '\n') i++;
    } else if (c === '\\') {
      if (next !== '\n' && next !== undefined) {
        word += next;
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        const d = command[j]!;
        if (d === '`' || (d === '$' && command[j + 1] === '(')) return undefined;
        if (d === '\\' && '"\\$`\n'.includes(command[j + 1] ?? '')) {
          if (command[j + 1] !== '\n') word += command[j + 1];
          j += 2;
        } else {
          word += d;
          j++;
        }
      }
      if (j >= command.length) return undefined;
      inWord = true;
      i = j + 1;
    } else if (c === '`' || (c === '$' && next === '(') || c === '(' || c === ')') {
      return undefined;
    } else if (c === '|') {
      endWord();
      if (next === '|') {
        tokens.push({ type: 'op', value: '||' });
        i += 2;
      } else {
        tokens.push({ type: 'op', value: '|' });
        i += next === '&' ? 2 : 1;
      }
    } else if (c === ';') {
      endWord();
      tokens.push({ type: 'op', value: ';' });
      i++;
    } else if (c === '&' && next === '&') {
      endWord();
      tokens.push({ type: 'op', value: '&&' });
      i += 2;
    } else if (c === '&' && next === '>') {
      endWord();
      const op = command[i + 2] === '>' ? '&>>' : '&>';
      tokens.push({ type: 'redirect', value: op });
      i += op.length;
    } else if (c === '&') {
      endWord();
      tokens.push({ type: 'op', value: '&' });
      i++;
    } else if (c === '>' || c === '<') {
      // A number right before the operator is the file descriptor: 2>, 1>>.
      let op = '';
      if (inWord && /^\d+$/.test(word)) {
        op = word;
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      if (c === '<' && (next === '<' || next === '(')) return undefined;
      if (c === '>' && next === '(') return undefined;
      op += c;
      i++;
      if (c === '>' && (command[i] === '>' || command[i] === '|')) op += command[i++];
      if (command[i] === '&') op += command[i++];
      tokens.push({ type: 'redirect', value: op });
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endWord();
  return tokens;
}

/** Splits a command line into simple commands. Returns undefined when it cannot be analyzed. */
export function parseCommandLine(command: string): SimpleCommand[] | undefined {
  const tokens = tokenize(command);
  if (!tokens) return undefined;
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [], joinedBy: undefined };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (token.type === 'word') {
      current.words.push(token.value);
    } else if (token.type === 'redirect') {
      const target = tokens[k + 1];
      if (target?.type !== 'word') return undefined;
      current.redirects.push({ op: token.value, target: target.value });
      k++;
    } else {
      if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
      current = { words: [], redirects: [], joinedBy: token.value };
    }
  }
  if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
  return commands;
}

/** Resolves a path written in a command against the directory the command ran in. */
export function resolvePath(dir: string, path: string): string {
  if (path.startsWith('~') || path.startsWith('$')) return path;
  return posix.resolve(dir, path);
}

export type { ReadKind };

/** A read found in a tool call, with absolute paths. */
export interface RawRead {
  tool: string;
  kind: ReadKind;
  /** file: one path. search and list: the paths searched or listed. */
  paths: string[];
  /** search: the pattern. */
  pattern?: string;
  /** search and list: globs, types or find expression that narrow the result. */
  filter?: string;
}

export interface BashAnalysis {
  /** Every program in the command reads or only formats text, and nothing is written. */
  readOnly: boolean;
  /** The reads of a read-only command. Empty when the command is not read-only. */
  reads: RawRead[];
  /** Absolute paths of the files the command writes, moves or deletes, as far as it can tell. */
  writes: string[];
}

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string[]>;
  operands: string[];
}

/**
 * Separates options from operands. `valuedShort` and `valuedLong` list the options that take a value.
 * Long options written as `--name=value` are always read as valued.
 */
function parseArgs(args: string[], valuedShort = '', valuedLong: string[] = []): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  const addValue = (name: string, value: string): void => {
    values.set(name, [...(values.get(name) ?? []), value]);
  };
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    if (arg === '--') {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) addValue(arg.slice(2, eq), arg.slice(eq + 1));
      else if (valuedLong.includes(arg.slice(2)) && k + 1 < args.length) addValue(arg.slice(2), args[++k]!);
      else flags.add(arg.slice(2));
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let p = 1; p < arg.length; p++) {
        const letter = arg[p]!;
        if (valuedShort.includes(letter)) {
          const rest = arg.slice(p + 1);
          if (rest) addValue(letter, rest);
          else if (k + 1 < args.length) addValue(letter, args[++k]!);
          break;
        }
        flags.add(letter);
      }
    } else {
      operands.push(arg);
    }
  }
  return { flags, values, operands };
}

interface CommandContext {
  dir: string;
  /** The command reads from a pipe. */
  piped: boolean;
  /** File redirected into the command with `<`. */
  input: string | undefined;
}

interface ReaderResult {
  readOnly: boolean;
  reads: RawRead[];
  writes?: string[];
}

const fileReads = (tool: string, files: string[], ctx: CommandContext): RawRead[] =>
  files.filter((file) => file !== '-').map((file) => ({ tool, kind: 'file' as const, paths: [resolvePath(ctx.dir, file)] }));

const withInput = (files: string[], ctx: CommandContext): string[] =>
  files.length === 0 && ctx.input !== undefined ? [ctx.input] : files;

const READERS: Record<string, (args: string[], ctx: CommandContext) => ReaderResult> = {
  cat(args, ctx) {
    return { readOnly: true, reads: fileReads('cat', withInput(parseArgs(args).operands, ctx), ctx) };
  },
  head(args, ctx) {
    return headOrTail('head', args, ctx);
  },
  tail(args, ctx) {
    return headOrTail('tail', args, ctx);
  },
  sed(args, ctx) {
    const parsed = parseArgs(args, 'efl', ['expression', 'file', 'line-length']);
    const inPlace = parsed.flags.has('i') || parsed.flags.has('in-place') || parsed.values.has('in-place');
    const hasScriptOption = parsed.values.has('e') || parsed.values.has('f') || parsed.values.has('expression') || parsed.values.has('file');
    let files = hasScriptOption ? parsed.operands : parsed.operands.slice(1);
    if (inPlace) {
      // BSD sed takes the backup suffix as a separate argument: sed -i '' 's/a/b/' file.
      if (!hasScriptOption && parsed.operands[0] === '') files = parsed.operands.slice(2);
      return { readOnly: false, reads: [], writes: files.map((file) => resolvePath(ctx.dir, file)) };
    }
    const quiet = parsed.flags.has('n') || parsed.flags.has('quiet') || parsed.flags.has('silent');
    if (!quiet) return { readOnly: false, reads: [] };
    return { readOnly: true, reads: fileReads('sed', withInput(files, ctx), ctx) };
  },
  grep: (args, ctx) => grep('grep', args, ctx),
  egrep: (args, ctx) => grep('egrep', args, ctx),
  fgrep: (args, ctx) => grep('fgrep', args, ctx),
  rg(args, ctx) {
    const parsed = parseArgs(args, 'efgtTmABCMdjEr', [
      'regexp', 'file', 'glob', 'iglob', 'type', 'type-not', 'max-count', 'after-context', 'before-context',
      'context', 'max-columns', 'max-depth', 'threads', 'encoding', 'replace', 'type-add', 'sort', 'sortr',
      'pre', 'pre-glob', 'max-filesize', 'path-separator', 'colors', 'engine', 'ignore-file',
    ]);
    const filter = [
      ...(parsed.values.get('g') ?? []), ...(parsed.values.get('glob') ?? []), ...(parsed.values.get('iglob') ?? []),
      ...(parsed.values.get('t') ?? []).map((t) => `type:${t}`), ...(parsed.values.get('type') ?? []).map((t) => `type:${t}`),
    ].join(' ');
    if (parsed.flags.has('files')) {
      const paths = parsed.operands.length > 0 ? parsed.operands : [ctx.dir];
      return { readOnly: true, reads: [{ tool: 'rg', kind: 'list', paths: paths.map((p) => resolvePath(ctx.dir, p)), filter: filter || undefined }] };
    }
    const fromOption = parsed.values.get('e') ?? parsed.values.get('regexp');
    const pattern = fromOption ? fromOption.join('|') : parsed.operands[0];
    const paths = fromOption ? parsed.operands : parsed.operands.slice(1);
    if (pattern === undefined) return { readOnly: true, reads: [] };
    if (paths.length === 0 && (ctx.piped || ctx.input !== undefined)) {
      return { readOnly: true, reads: ctx.input !== undefined ? [searchRead('rg', pattern, [ctx.input], filter, ctx)] : [] };
    }
    return { readOnly: true, reads: [searchRead('rg', pattern, paths.length > 0 ? paths : [ctx.dir], filter, ctx)] };
  },
  find(args, ctx) {
    let k = 0;
    while (args[k] === '-L' || args[k] === '-H' || args[k] === '-P') k++;
    const paths: string[] = [];
    while (k < args.length && !args[k]!.startsWith('-') && args[k] !== '!' && args[k] !== '(') paths.push(args[k++]!);
    const expression = args.slice(k);
    if (expression.some((word) => FIND_ACTIONS_THAT_WRITE.has(word))) return { readOnly: false, reads: [] };
    return {
      readOnly: true,
      reads: [{
        tool: 'find', kind: 'list',
        paths: (paths.length > 0 ? paths : [ctx.dir]).map((p) => resolvePath(ctx.dir, p)),
        filter: expression.length > 0 ? expression.join(' ') : undefined,
      }],
    };
  },
  ls(args, ctx) {
    const parsed = parseArgs(args, 'ITw', ['ignore', 'hide', 'width', 'tabsize', 'format', 'sort', 'time', 'time-style', 'quoting-style', 'indicator-style', 'block-size']);
    const paths = parsed.operands.length > 0 ? parsed.operands : [ctx.dir];
    return { readOnly: true, reads: [{ tool: 'ls', kind: 'list', paths: paths.map((p) => resolvePath(ctx.dir, p)) }] };
  },
};

const FIND_ACTIONS_THAT_WRITE = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

function headOrTail(tool: 'head' | 'tail', args: string[], ctx: CommandContext): ReaderResult {
  // `head -20 file` is the old form of `head -n 20 file`.
  const normalized = args.map((arg) => (/^-\d+$/.test(arg) ? `-n${arg.slice(1)}` : arg));
  const parsed = parseArgs(normalized, 'nc', ['lines', 'bytes']);
  return { readOnly: true, reads: fileReads(tool, withInput(parsed.operands, ctx), ctx) };
}

function searchRead(tool: string, pattern: string, paths: string[], filter: string, ctx: CommandContext): RawRead {
  return { tool, kind: 'search', pattern, paths: paths.map((p) => resolvePath(ctx.dir, p)), filter: filter || undefined };
}

function grep(tool: string, args: string[], ctx: CommandContext): ReaderResult {
  const parsed = parseArgs(args, 'efmABCdD', [
    'regexp', 'file', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude',
    'exclude-dir', 'exclude-from', 'label', 'devices', 'directories', 'binary-files',
  ]);
  const fromOption = parsed.values.get('e') ?? parsed.values.get('regexp');
  const pattern = fromOption ? fromOption.join('|') : parsed.operands[0];
  const paths = fromOption ? parsed.operands : parsed.operands.slice(1);
  if (pattern === undefined) return { readOnly: true, reads: [] };
  const filter = [...(parsed.values.get('include') ?? []), ...(parsed.values.get('exclude') ?? []).map((g) => `!${g}`)].join(' ');
  const recursive = ['r', 'R', 'recursive', 'dereference-recursive'].some((flag) => parsed.flags.has(flag));
  if (paths.length > 0) return { readOnly: true, reads: [searchRead(tool, pattern, paths, filter, ctx)] };
  if (ctx.input !== undefined) return { readOnly: true, reads: [searchRead(tool, pattern, [ctx.input], filter, ctx)] };
  // With no path, grep filters its input; with -r it searches the current folder.
  return { readOnly: true, reads: recursive && !ctx.piped ? [searchRead(tool, pattern, [ctx.dir], filter, ctx)] : [] };
}

/** Programs that only print or format text. They neither read project files nor write any. */
const NEUTRAL = new Set(['pwd', 'echo', 'printf', 'true', 'test', '[', 'wc', 'uniq', 'cut', 'tr', 'nl', 'column', 'basename', 'dirname']);

const WRITERS: Record<string, (args: string[], dir: string) => string[]> = {
  tee: (args, dir) => parseArgs(args).operands.map((file) => resolvePath(dir, file)),
  touch: (args, dir) => parseArgs(args, 'dtr').operands.map((file) => resolvePath(dir, file)),
  rm: (args, dir) => parseArgs(args).operands.map((file) => resolvePath(dir, file)),
  mv: (args, dir) => parseArgs(args, 'tS').operands.map((file) => resolvePath(dir, file)),
  cp: (args, dir) => parseArgs(args, 'tS').operands.slice(-1).map((file) => resolvePath(dir, file)),
  sort: (args, dir) => [...(parseArgs(args, 'ktTSo', ['output', 'key', 'field-separator']).values.get('o') ?? [])].map((file) => resolvePath(dir, file)),
};

const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/**
 * Tells whether a Bash command only reads, and what it reads and writes.
 *
 * A command is read-only when every program in it is one of `cat`, `sed -n`, `head`, `tail`,
 * `grep`, `rg`, `find`, `ls`, or a helper that only formats text (`wc`, `cut`, `echo`, …), and no
 * output is redirected to a file. `cd` changes the folder that the following paths are resolved in.
 *
 * @param cwd Absolute folder the command started in.
 */
export function analyzeBash(command: string, cwd: string): BashAnalysis {
  const commands = parseCommandLine(command);
  if (!commands) return { readOnly: false, reads: [], writes: [] };

  let dir = cwd;
  let readOnly = true;
  const reads: RawRead[] = [];
  const writes: string[] = [];

  for (const simple of commands) {
    for (const { op, target } of simple.redirects) {
      if (!op.includes('>')) continue;
      const duplicatesDescriptor = op.endsWith('&') && /^(\d+|-)$/.test(target);
      if (duplicatesDescriptor || target === '/dev/null') continue;
      writes.push(resolvePath(dir, target));
      readOnly = false;
    }

    let start = 0;
    while (start < simple.words.length && isAssignment(simple.words[start]!)) start++;
    const program = simple.words[start] === undefined ? undefined : posix.basename(simple.words[start]!);
    const args = simple.words.slice(start + 1);
    if (program === undefined) continue;

    if (program === 'cd') {
      if (args[0] !== undefined && args[0] !== '-' && !args[0].startsWith('-')) dir = resolvePath(dir, args[0]);
      continue;
    }

    const reader = READERS[program];
    if (reader) {
      const input = simple.redirects.find((redirect) => redirect.op === '<')?.target;
      const result = reader(args, { dir, piped: simple.joinedBy === '|', input: input && resolvePath(dir, input) });
      reads.push(...result.reads);
      writes.push(...(result.writes ?? []));
      if (!result.readOnly) readOnly = false;
      continue;
    }

    const writer = WRITERS[program];
    if (writer) {
      const written = writer(args, dir);
      writes.push(...written);
      if (program !== 'sort' || written.length > 0) readOnly = false;
      continue;
    }

    if (!NEUTRAL.has(program)) readOnly = false;
  }

  return { readOnly, reads: readOnly ? reads : [], writes };
}
