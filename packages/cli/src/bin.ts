#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import pc from 'picocolors';
import { type ChunkCache, defaultCacheDir } from './chunk-cache';
import { type CompareCommandOptions, runCompare } from './compare';
import { DEFAULT_MIN_TOKENS, DEFAULT_STATE_DIR, type HookIO, prepareHandoff, runGuard, runHandoff } from './guard';
import { type RecallCommandOptions, runRecall } from './recall';
import { type ProfileCommandOptions, runProfile } from './run-profile';
import { runSetup, type SetupOptions } from './setup';
import { runStatus, type StatusCommandOptions } from './status';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command('arricurdai')
  .description('Shows where the tokens of a Claude Code project go, stops costly resumes, and finds what earlier sessions said.')
  .version(version);

program
  .command('profile')
  .description('Profile the Claude Code sessions of a project. Reads local files only.')
  .option('--project <path>', 'project folder', '.')
  .option('--sessions <n>', 'how many of the most recent sessions to measure', '20')
  .option('--json', 'print the report as JSON')
  .option('--config <file>', 'cost parameters (default: arricurdai.config.json in the project)')
  .option('--transcripts <dir>', 'transcript folder of the project (default: found from the project path)')
  .action(async (options: ProfileCommandOptions) => {
    process.exitCode = await runProfile(options, {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      now: () => new Date(),
      colors: pc.isColorSupported,
    });
  });

program
  .command('compare')
  .description('Compare the sessions of a project before and after a date, and estimate what the limit and the guard did. Reads local files only.')
  .requiredOption('--since <date>', 'the day something changed, such as 2026-10-26: sessions started from then on are the later ones')
  .option('--until <date>', 'leave out sessions started from this date on')
  .option('--window <tokens>', 'auto-compact window of the replays with no limit (default: the largest request of the sessions)')
  .option('--project <path>', 'project folder', '.')
  .option('--json', 'print the comparison as JSON')
  .option('--config <file>', 'cost parameters (default: arricurdai.config.json in the project)')
  .option('--transcripts <dir>', 'transcript folder of the project (default: found from the project path)')
  .action(async (options: CompareCommandOptions) => {
    process.exitCode = await runCompare(options, {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      now: () => new Date(),
      colors: pc.isColorSupported,
    });
  });

program
  .command('status')
  .description('Show the Claude Code sessions of the last hours: how large their context is and when their prompt cache expires. Reads local files only.')
  .option('--hours <n>', 'sessions active in the last n hours', '24')
  .option('--limit <n>', 'most sessions to show', '10')
  .option('--min-tokens <n>', 'smallest context the guard stops for', String(DEFAULT_MIN_TOKENS))
  .option('--json', 'print the status as JSON')
  .option('--swiftbar', 'print the status as a SwiftBar or xbar menu, for the macOS menu bar')
  .action(async (options: StatusCommandOptions) => {
    process.exitCode = await runStatus(options, {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      now: () => new Date(),
      colors: false,
      node: process.execPath,
      bin: realpathSync(process.argv[1] ?? ''),
    });
  });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The chunks recall keeps are of this version: another one reads the transcripts again. */
function chunkCache(): ChunkCache | undefined {
  const dir = defaultCacheDir(process.env);
  return dir === undefined ? undefined : { dir, stamp: version };
}

const hookIO = (): HookIO => ({
  stdout: (text) => process.stdout.write(text),
  now: () => new Date(),
  stateDir: DEFAULT_STATE_DIR,
  recallCommand: `node "${process.argv[1]}" recall`,
  cache: chunkCache(),
});

program
  .command('recall')
  .description('Search the earlier Claude Code sessions of a project for what was asked, decided and changed. Reads local files only.')
  .argument('<words...>', 'what to look for')
  .option('--project <path>', 'project folder', '.')
  .option('--transcripts <dir>', 'transcript folder of the project (default: found from the project path)')
  .option('--limit <n>', 'most matches to show', '5')
  .option('--max-tokens <n>', 'most tokens to print', '1500')
  .option('--json', 'print the matches as JSON')
  .option('--no-cache', 'read every transcript again, and keep nothing of them for the next search')
  .action(async (words: string[], options: RecallCommandOptions & { cache: boolean }) => {
    process.exitCode = await runRecall(words, options, {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      now: () => new Date(),
      colors: false,
      cache: options.cache ? chunkCache() : undefined,
    });
  });

program
  .command('guard')
  .description('Claude Code UserPromptSubmit hook: stops the first prompt after the prompt cache of a large session expired.')
  .option('--min-tokens <n>', 'smallest context worth stopping for', String(DEFAULT_MIN_TOKENS))
  .action(async (options: { minTokens?: string }) => {
    process.exitCode = runGuard(await readStdin(), options, hookIO());
  });

program
  .command('handoff')
  .description('Claude Code SessionStart hook: after /clear, gives the new session a note on the one the guard stopped.')
  .option('--prepare', 'not as a hook: write the note on a session for the next /clear in its project, as the guard does when it stops a prompt (for tools that send /clear themselves)')
  .option('--transcript <path>', 'with --prepare: the transcript of the session')
  .action(async (options: { prepare?: boolean; transcript?: string }) => {
    if (!options.prepare) {
      process.exitCode = runHandoff(await readStdin(), hookIO());
      return;
    }
    const result = options.transcript ? prepareHandoff(options.transcript, hookIO()) : { ok: false as const, error: '--transcript <path> is required' };
    if (!result.ok) process.stderr.write(`arricurdai handoff --prepare: ${result.error}\n`);
    process.exitCode = result.ok ? 0 : 1;
  });

/** Reads one line of the terminal. With no terminal to answer from, the answer is no. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  for await (const line of process.stdin) return /^\s*y(es)?\s*$/i.test(String(line));
  return false;
}

program
  .command('setup')
  .description('Turn on the guard and handoff hooks in the Claude Code settings. Shows the changes and asks first.')
  .option('--project <path>', 'for one project only, in its .claude/settings.local.json')
  .option('--remove', 'turn the hooks off')
  .option('-y, --yes', 'apply the changes without asking')
  .action(async (options: SetupOptions) => {
    process.exitCode = await runSetup(options, {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      now: () => new Date(),
      colors: false,
      bin: realpathSync(process.argv[1] ?? ''),
      confirm,
    });
  });

await program.parseAsync();
