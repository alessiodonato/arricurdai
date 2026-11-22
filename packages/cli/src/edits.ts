import { createReadStream } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { analyzeBash, claudeConfigDir, parseCommandLine } from '@arricurdai/transcripts';
import { type CommandIO, UserError, withErrors } from './run-profile';
import { recentTranscripts } from './status';

// `arricurdai edits`: how Claude Code changed the files of your projects in the last days. With the edit tools
// (Edit, Write, MultiEdit, NotebookEdit), which a hook on those tools sees; with a shell command whose line names
// the file (sed -i, >, tee, cp, mv, rm), which a hook can only read from the command line; or inside a script
// (python -c, node -e, a here-document fed to an interpreter), which neither sees. Only counts are printed: no
// text of a session, no file name, no project name. Local files only.

export interface EditsCommandOptions {
  days?: string;
  json?: boolean;
}

export interface EditCounts {
  /** Edit, Write, MultiEdit and NotebookEdit calls on a file of the project. */
  tools: number;
  /** Bash commands whose line names a file of the project they write. */
  shell: number;
  /** Bash commands that run code which writes a file of the project, named in the code: the line does not say it. */
  scripts: number;
}

export interface EditsReport extends EditCounts {
  generatedAt: string;
  days: number;
  sessions: number;
  /** Sessions that ran in auto mode at least once. */
  autoSessions: number;
  /** The shell commands by the form of the write. */
  shellKinds: Record<ShellKind, number>;
  /** Scripts that write files whose path is not in the code (a variable): in the project or not, nobody can tell. */
  scriptsUnnamed: number;
  /** Bash commands that cannot be read without running them ($(...), subshells): not counted above. */
  unreadable: number;
  /** The last weeks, oldest first, each from its first day. */
  weeks: Array<{ from: string } & EditCounts>;
}

export type ShellKind = 'here-document' | 'sed -i' | 'redirect' | 'tee' | 'cp, mv, rm' | 'other';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DAY = 24 * 60 * 60 * 1000;

/**
 * The command without the bodies of its here-documents, and without their `<<WORD`: what they hold is text for
 * a program, not commands. What stays can be read (cat > f.ts) where the whole line could not.
 */
export function withoutHeredocs(command: string): string {
  const opener = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
  const kept: string[] = [];
  const waiting: Array<{ word: string; tabs: boolean }> = [];
  for (const line of command.split('\n')) {
    const open = waiting[0];
    if (open) {
      if ((open.tabs ? line.replace(/^\t+/, '') : line) === open.word) waiting.shift();
      continue;
    }
    for (const match of line.matchAll(opener)) waiting.push({ word: match[3]!, tabs: match[1] === '-' });
    kept.push(line.replace(opener, ''));
  }
  return kept.join('\n');
}

const INTERPRETER = /(^|[\s;&|(])(python3?|node|ruby|perl|bun|deno|php)(\s|$)/;
/** A call in the code of a script that writes a file: open(…, 'w'), write_text, writeFileSync and the like. */
const WRITES_IN_CODE = /open\([^)]*,\s*['"][wax]b?\+?['"]|\.write_text\(|\.write_bytes\(|writeFileSync\(|appendFileSync\(|promises\.writeFile\(|\bwriteFile\(|File\.write\(/;
/** The files those calls name with a literal path: the first argument, in quotes. */
const NAMED_IN_CODE = [
  /open\(\s*(['"])([^'"\n]+)\1\s*,\s*['"][wax]/g,
  /(?:writeFileSync|appendFileSync|writeFile)\(\s*(['"`])([^'"`\n]+)\1/g,
  /Path\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g,
  /File\.write\(\s*(['"])([^'"\n]+)\1/g,
];

/** The files a script names in its code where it writes them, absolute. */
function namedInCode(code: string, cwd: string): string[] {
  const found: string[] = [];
  for (const pattern of NAMED_IN_CODE) for (const match of code.matchAll(pattern)) found.push(isAbsolute(match[2]!) ? match[2]! : `${cwd}/${match[2]!}`);
  return found;
}

/** A script that writes: 'script' when it names a file of the project, 'script-unnamed' when the path is not in the code. */
function scriptWrites(command: string, cwd: string): 'script' | 'script-unnamed' | undefined {
  if (!WRITES_IN_CODE.test(command)) return undefined;
  const named = namedInCode(command, cwd);
  if (named.length === 0) return 'script-unnamed';
  return named.some((path) => inProject(path, cwd)) ? 'script' : undefined;
}

/** A file of the project: inside the folder the session ran in, outside .git and node_modules. */
function inProject(path: string, cwd: string): boolean {
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split('/');
  return !parts.includes('.git') && !parts.includes('node_modules');
}

function shellKind(command: string, heredoc: boolean): ShellKind {
  if (heredoc) return 'here-document';
  if (/\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i/.test(command) || /--in-place/.test(command)) return 'sed -i';
  if (/\btee\b/.test(command)) return 'tee';
  if (/(^|[\s;&|])(cp|mv|rm)\s/.test(command)) return 'cp, mv, rm';
  if (/>/.test(command)) return 'redirect';
  return 'other';
}

/** How one Bash command changed the files of the project, as far as its line tells. */
export function classifyBash(command: string, cwd: string): 'shell' | 'script' | 'script-unnamed' | 'unreadable' | undefined {
  const plain = withoutHeredocs(command);
  if (parseCommandLine(plain) === undefined) return (INTERPRETER.test(command) && scriptWrites(command, cwd)) || 'unreadable';
  if (analyzeBash(plain, cwd).writes.some((path) => inProject(path, cwd))) return 'shell';
  // A script run on the line (python -c, node -e) or fed a here-document: what it writes is in its code.
  return INTERPRETER.test(plain) ? scriptWrites(command, cwd) : undefined;
}

interface Totals extends EditCounts {
  kinds: Record<ShellKind, number>;
  scriptsUnnamed: number;
  unreadable: number;
}

const zero = (): EditCounts => ({ tools: 0, shell: 0, scripts: 0 });

/** Reads the transcripts of the last days and counts how their sessions changed files. */
export async function readEdits(claudeDir: string, now: Date, days: number): Promise<EditsReport> {
  const since = now.getTime() - days * DAY;
  const files = recentTranscripts(claudeDir, since);
  const sessions = new Set<string>();
  const auto = new Set<string>();
  const weeks = Array.from({ length: Math.ceil(days / 7) }, zero);
  const totals: Totals = { ...zero(), kinds: { 'here-document': 0, 'sed -i': 0, redirect: 0, tee: 0, 'cp, mv, rm': 0, other: 0 }, scriptsUnnamed: 0, unreadable: 0 };
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file.path, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"tool_use"') && !line.includes('"permissionMode"')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(at) || at < since || at > now.getTime()) continue;
      sessions.add(file.session);
      if (entry.permissionMode === 'auto') auto.add(file.session);
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      if (!cwd || !Array.isArray(content)) continue;
      const week = weeks[Math.min(weeks.length - 1, Math.floor((now.getTime() - at) / (7 * DAY)))]!;
      for (const block of content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') continue;
        const { name, input } = block as { name?: unknown; input?: Record<string, unknown> };
        if (typeof name !== 'string' || !input) continue;
        if (FILE_TOOLS.has(name)) {
          const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
          if (path && inProject(isAbsolute(path) ? path : `${cwd}/${path}`, cwd)) {
            totals.tools++;
            week.tools++;
          }
          continue;
        }
        if (name !== 'Bash' || typeof input.command !== 'string') continue;
        const found = classifyBash(input.command, cwd);
        if (found === 'shell') {
          totals.shell++;
          week.shell++;
          const plain = withoutHeredocs(input.command);
          totals.kinds[shellKind(plain, plain !== input.command)]++;
        } else if (found === 'script') {
          totals.scripts++;
          week.scripts++;
        } else if (found === 'script-unnamed') totals.scriptsUnnamed++;
        else if (found === 'unreadable') totals.unreadable++;
      }
    }
  }
  // The oldest week is shorter when the days are not a multiple of 7: it starts where the days start.
  const start = (index: number): string => new Date(Math.max(since, now.getTime() - (index + 1) * 7 * DAY)).toISOString().slice(0, 10);
  return {
    generatedAt: now.toISOString(),
    days,
    sessions: sessions.size,
    autoSessions: auto.size,
    tools: totals.tools,
    shell: totals.shell,
    scripts: totals.scripts,
    shellKinds: totals.kinds,
    scriptsUnnamed: totals.scriptsUnnamed,
    unreadable: totals.unreadable,
    weeks: weeks.map((counts, index) => ({ from: start(index), ...counts })).reverse(),
  };
}

const number = (value: number): string => value.toLocaleString('en-US');
const share = (part: number, all: number): string => (all === 0 ? '  -' : `${Math.round((100 * part) / all)}%`.padStart(4));

export function renderEdits(report: EditsReport): string {
  const all = report.tools + report.shell + report.scripts;
  if (all === 0) return `No Claude Code session changed a file of its project in the last ${report.days} days.\n`;
  const rows: Array<[string, number]> = [
    ['with Edit, Write, MultiEdit or NotebookEdit', report.tools],
    ['with a shell command (sed -i, >, tee, cp…)', report.shell],
    ['inside a script, named in its code', report.scripts],
  ];
  const width = Math.max(...rows.map(([, value]) => number(value).length));
  const kinds = Object.entries(report.shellKinds)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, value]) => `${number(value)} ${kind}`);
  const lines = [
    `How Claude Code changed the files of your projects in the last ${report.days} days`,
    `${number(report.sessions)} sessions${report.autoSessions > 0 ? `, ${number(report.autoSessions)} of them in auto mode` : ''}`,
    '',
    ...rows.map(([label, value]) => `  ${label.padEnd(46)} ${number(value).padStart(width)}  ${share(value, all)}`),
    '',
    'A hook on the edit tools sees only the first line. The second one it can read from the',
    'command line; the third one from neither.',
    '',
    ...(kinds.length > 0 ? [`Shell commands: ${kinds.join(', ')}.`] : []),
    `By week (edit tools / shell / scripts): ${report.weeks.map((week) => `${week.from.slice(5)} ${week.tools}/${week.shell}/${week.scripts}`).join('  ')}`,
    ...(report.scriptsUnnamed > 0 ? [`Not counted: ${number(report.scriptsUnnamed)} scripts that write a file their code does not name (a variable), in the project or not.`] : []),
    ...(report.unreadable > 0 ? [`Not counted: ${number(report.unreadable)} commands the line cannot tell without running them ($(…), subshells).`] : []),
    '',
    'Counted from your local transcripts: no text of a session, no file or project name is shown.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function runEdits(options: EditsCommandOptions, io: CommandIO): Promise<number> {
  return withErrors(io, async () => {
    const days = Number(options.days ?? '30');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserError('--days must be a whole number from 1 to 365');
    const report = await readEdits(claudeConfigDir(io.env), io.now(), days);
    io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderEdits(report));
  });
}
