import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** The Claude Code config folder: `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Name of a project's transcript folder: every character that is not a letter or a digit becomes `-`. */
export function encodeProjectPath(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SubagentFile {
  agentId: string;
  file: string;
  metaFile: string | undefined;
}

export interface SessionFiles {
  sessionId: string;
  file: string;
  subagents: SubagentFile[];
}

export interface TranscriptsLocation {
  dir: string;
  /** `path`: the folder named after the project path. `cwd`: another folder whose sessions ran in the project. */
  matchedBy: 'path' | 'cwd';
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** First value of a string field in the first lines of a JSONL file. */
async function firstStringField(file: string, field: string, maxLines = 50): Promise<string | undefined> {
  const stream = createReadStream(file, 'utf8');
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > maxLines) break;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'object' && value !== null && field in value) {
          const found = (value as Record<string, unknown>)[field];
          if (typeof found === 'string') return found;
        }
      } catch {
        // A broken line says nothing about the session; keep looking.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

function firstSessionFile(dir: string): string | undefined {
  const name = readdirSync(dir).sort().find((entry) => entry.endsWith('.jsonl') && !entry.startsWith('agent-'));
  return name === undefined ? undefined : join(dir, name);
}

/**
 * Finds the transcript folder of a project.
 *
 * It tries the folder named after the encoded project path first. Different paths can encode to the
 * same name, so it checks the `cwd` recorded in that folder, and otherwise looks for another folder
 * whose sessions ran in the project.
 *
 * @param projectRoot Absolute, resolved path of the project.
 */
export async function findTranscriptsDir(projectRoot: string, claudeDir = claudeConfigDir()): Promise<TranscriptsLocation | undefined> {
  const projects = join(claudeDir, 'projects');
  if (!isDirectory(projects)) return undefined;

  const direct = join(projects, encodeProjectPath(projectRoot));
  if (isDirectory(direct)) {
    const sample = firstSessionFile(direct);
    const cwd = sample === undefined ? undefined : await firstStringField(sample, 'cwd');
    if (cwd === undefined || cwd === projectRoot) return { dir: direct, matchedBy: 'path' };
  }

  for (const entry of readdirSync(projects).sort()) {
    const dir = join(projects, entry);
    if (dir === direct || !isDirectory(dir)) continue;
    const sample = firstSessionFile(dir);
    if (sample !== undefined && (await firstStringField(sample, 'cwd')) === projectRoot) return { dir, matchedBy: 'cwd' };
  }
  return undefined;
}

/**
 * Lists the sessions in a transcript folder, each with the transcripts of its subagents.
 *
 * Subagents live in `<sessionId>/subagents/agent-<id>.jsonl`. An `agent-<id>.jsonl` at the top of the
 * folder, as some layouts have, is attached to the session named in its lines.
 */
export async function listSessionFiles(dir: string): Promise<SessionFiles[]> {
  const entries = readdirSync(dir).sort();
  const sessions = new Map<string, SessionFiles>();

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || entry.startsWith('agent-')) continue;
    const sessionId = entry.slice(0, -'.jsonl'.length);
    const subagentDir = join(dir, sessionId, 'subagents');
    const subagents = isDirectory(subagentDir)
      ? readdirSync(subagentDir)
          .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
          .sort()
          .map((name) => {
            const agentId = name.slice('agent-'.length, -'.jsonl'.length);
            const metaFile = join(subagentDir, `agent-${agentId}.meta.json`);
            return { agentId, file: join(subagentDir, name), metaFile: existsSync(metaFile) ? metaFile : undefined };
          })
      : [];
    sessions.set(sessionId, { sessionId, file: join(dir, entry), subagents });
  }

  for (const entry of entries) {
    if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
    const file = join(dir, entry);
    const sessionId = await firstStringField(file, 'sessionId');
    const session = sessionId === undefined ? undefined : sessions.get(sessionId);
    session?.subagents.push({ agentId: entry.slice('agent-'.length, -'.jsonl'.length), file, metaFile: undefined });
  }

  return [...sessions.values()];
}
