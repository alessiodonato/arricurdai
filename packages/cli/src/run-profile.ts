import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, type CostParams, DEFAULT_SESSION_WINDOW, parseCostParams, profile, type Report } from '@arricurdai/core';
import { claudeConfigDir, discoverMemoryFiles, encodeProjectPath, findTranscriptsDir, parseProject } from '@arricurdai/transcripts';
import { loadGitHistory } from './git';
import { renderReport } from './render';

export interface ProfileCommandOptions {
  project?: string;
  sessions?: string;
  json?: boolean;
  config?: string;
  transcripts?: string;
}

/** Everything the command touches outside its arguments, so tests can replace it. */
export interface CommandIO {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  colors: boolean;
}

/** A problem the user can fix: shown as one line, without a stack trace. */
export class UserError extends Error {
  override name = 'UserError';
}

export const CONFIG_FILE = 'arricurdai.config.json';

function existingFolder(path: string, what: string): string {
  try {
    if (statSync(path).isDirectory()) return realpathSync(path);
  } catch {
    // Reported below.
  }
  throw new UserError(`${what} not found: ${path}`);
}

function sessionWindow(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SESSION_WINDOW;
  const sessions = Number(value);
  if (!Number.isInteger(sessions) || sessions < 1) throw new UserError(`--sessions must be a whole number of 1 or more, got "${value}"`);
  return sessions;
}

/** Reads the cost parameters. Without --config, a missing arricurdai.config.json means the defaults. */
function costParams(option: string | undefined, projectRoot: string, cwd: string): CostParams {
  const path = option === undefined ? join(projectRoot, CONFIG_FILE) : resolve(cwd, option);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (option === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return parseCostParams(undefined);
    throw new UserError(`cannot read the config file ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UserError(`the config file ${path} is not valid JSON`);
  }
  try {
    return parseCostParams(json);
  } catch (error) {
    if (error instanceof ConfigError) throw new UserError(`${path}: ${error.message}`);
    throw error;
  }
}

/** Builds the report of a project. Throws UserError for problems the user can fix. */
export async function buildReport(options: ProfileCommandOptions, io: Pick<CommandIO, 'cwd' | 'env' | 'now'>): Promise<Report> {
  const projectRoot = existingFolder(resolve(io.cwd, options.project ?? '.'), 'Project folder');
  const sessions = sessionWindow(options.sessions);
  const params = costParams(options.config, projectRoot, io.cwd);
  const claudeDir = claudeConfigDir(io.env);

  let transcripts: string;
  if (options.transcripts !== undefined) {
    transcripts = existingFolder(resolve(io.cwd, options.transcripts), 'Transcript folder');
  } else {
    const found = await findTranscriptsDir(projectRoot, claudeDir);
    if (!found) {
      throw new UserError(
        `no Claude Code transcripts found for ${projectRoot}. Expected them in ${join(claudeDir, 'projects', encodeProjectPath(projectRoot))}. ` +
          'Run Claude Code in this project first, or point at the transcripts with --transcripts <dir>.',
      );
    }
    transcripts = found.dir;
  }

  const project = await parseProject(transcripts);
  const git = await loadGitHistory(projectRoot, project.sessions[0]?.startedAt);
  const diskMemory = project.sessions.some((session) => !session.recordsMemory)
    ? discoverMemoryFiles(projectRoot, { claudeDir, transcriptsDir: transcripts })
    : undefined;

  return profile(project, {
    projectRoot,
    generatedAt: io.now().toISOString(),
    params,
    sessions,
    ...(git ? { changedBetween: git.changedBetween } : {}),
    ...(diskMemory ? { diskMemory } : {}),
  });
}

/** Runs `arricurdai profile` and returns the exit code. Never throws. */
export async function runProfile(options: ProfileCommandOptions, io: CommandIO): Promise<number> {
  try {
    const report = await buildReport(options, io);
    io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, { colors: io.colors, home: io.env.HOME }));
    return 0;
  } catch (error) {
    if (error instanceof UserError) {
      io.stderr(`arricurdai: ${error.message}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`arricurdai: unexpected error: ${message}\nSet ARRICURDAI_DEBUG=1 to see where it happened.\n`);
      if (io.env.ARRICURDAI_DEBUG && error instanceof Error && error.stack) io.stderr(`${error.stack}\n`);
    }
    return 1;
  }
}
