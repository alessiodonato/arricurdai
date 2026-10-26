#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_MIN_TOKENS, DEFAULT_STATE_DIR, type HookIO, runGuard, runHandoff } from './guard';
import { type ProfileCommandOptions, runProfile } from './run-profile';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command('arricurdai')
  .description('Measures what a Claude Code project spends on context it already knew.')
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const hookIO = (): HookIO => ({ stdout: (text) => process.stdout.write(text), now: () => new Date(), stateDir: DEFAULT_STATE_DIR });

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
  .action(async () => {
    process.exitCode = runHandoff(await readStdin(), hookIO());
  });

await program.parseAsync();
