import type { CostParams } from './config';
import { rent } from './cost';
import type { ProfileSession, SessionContext, SessionRead } from './session';

/** Tells whether a file changed between two ISO times: true, false, or undefined when it cannot tell. */
export type ChangeOracle = (path: string, since: string, until: string) => boolean | undefined;

/**
 * Turns a block keeps being read after the call where it entered: up to the next compaction, which
 * drops it from the context, or to the last call of the context.
 */
export function turnsInContext(context: Pick<SessionContext, 'calls' | 'compactions'>, turn: number): number {
  let end = context.calls.length;
  for (const boundary of context.compactions) if (boundary >= turn && boundary < end) end = boundary;
  return Math.max(0, end - turn);
}

export interface ReadVerdict {
  sessionId: string;
  context: SessionContext;
  read: SessionRead;
  /** The same key was read in an earlier session and nothing changed since. */
  rediscovery: boolean;
  /** Rent of the read when it is a rediscovery, 0 otherwise. */
  cost: number;
  /** A file rediscovery that git could not confirm, because there is no git history for it. */
  unchecked: boolean;
}

interface Known {
  timestamp: string | undefined;
  resultHash: string;
}

const byStart = (a: ProfileSession, b: ProfileSession): number =>
  (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿');

/**
 * Judges every context read of every session.
 *
 * A read is a rediscovery when the same key was read in an earlier session of the project and:
 * - for a file, the file did not change since, neither in the transcripts (Edit, Write, Bash writes)
 *   nor in git;
 * - for a search or a listing, the result is identical.
 *
 * Failed calls and results that never reached the model are neither rediscoveries nor knowledge.
 */
export function judgeReads(sessions: readonly ProfileSession[], params: CostParams, changedBetween?: ChangeOracle): ReadVerdict[] {
  const ordered = [...sessions].sort(byStart);

  const changes = new Map<string, string[]>();
  for (const session of ordered) {
    for (const change of session.fileChanges) {
      if (change.timestamp === undefined) continue;
      changes.set(change.path, [...(changes.get(change.path) ?? []), change.timestamp]);
    }
  }
  const changedInTranscripts = (path: string, since: string, until: string): boolean =>
    (changes.get(path) ?? []).some((time) => time > since && time <= until);

  const known = new Map<string, Known>();
  const verdicts: ReadVerdict[] = [];

  for (const session of ordered) {
    const learned = new Map<string, Known>();
    for (const context of [session.main, ...session.subagents]) {
      for (const read of context.reads) {
        if (read.isError || read.turn === undefined) continue;
        const previous = known.get(read.key);
        let rediscovery = false;
        let unchecked = false;

        if (previous && read.kind === 'file') {
          const since = previous.timestamp;
          const until = read.timestamp;
          if (since === undefined || until === undefined) {
            rediscovery = true;
            unchecked = true;
          } else if (!changedInTranscripts(read.target, since, until)) {
            const inGit = changedBetween?.(read.target, since, until);
            rediscovery = inGit !== true;
            unchecked = inGit === undefined;
          }
        } else if (previous) {
          rediscovery = read.resultHash === previous.resultHash;
        }

        const cost = rediscovery ? rent(read.tokens, turnsInContext(context, read.turn), params, context.cacheTtl) : 0;
        verdicts.push({ sessionId: session.sessionId, context, read, rediscovery, cost, unchecked: rediscovery && unchecked });
        learned.set(read.key, { timestamp: read.timestamp, resultHash: read.resultHash });
      }
    }
    // What a session reads becomes known only to the sessions after it.
    for (const [key, value] of learned) known.set(key, value);
  }
  return verdicts;
}
