#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import pc from 'picocolors';
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

await program.parseAsync();
