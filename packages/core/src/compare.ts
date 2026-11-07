import { contextShape, median, sessionBreakdown } from './breakdown';
import type { CostParams } from './config';
import { weightedCost } from './cost';
import { compactionSizes } from './profile';
import { type ChangeOracle, judgeReads } from './rediscovery';
import { replaySession, type SimulationSizes } from './simulate';
import type { ProfileSession, SessionContext } from './session';

/** How a search of earlier sessions shows among the blocks of a context, whatever the path of the command. */
export const RECALL_LABEL = 'Bash: arricurdai recall';
/** The block of the handoff hook: the note, and the line on how to search earlier sessions. */
const HANDOFF_LABEL = 'Claude Code: hook_additional_context';

export interface PeriodMeasures {
  sessions: number;
  /** API calls of the main contexts and of the subagents. */
  calls: number;
  prompts: number;
  cost: number;
  /** Mean size of the requests of the main contexts. */
  averageContext: number;
  largestContext: number;
  cacheRewrites: number;
  autoCompactions: number;
  manualCompactions: number;
  guardStops: number;
  notes: number;
  recallSearches: number;
  /** What the note and the line of the handoff hook cost, with their rent. */
  handoffCost: number;
  /** What the searches of recall cost: the call each one takes, and the rent of its result. */
  recallCost: number;
  /** Rent of what was read again though an earlier session had read it and nothing changed. */
  rereadCost: number;
}

/** The sessions after the date, replayed. */
export interface CompareScenario {
  cost: number;
  /** Compactions the window added. */
  compactions: number;
  /** Real automatic compactions left out. */
  skipped: number;
}

export interface Comparison {
  since: string;
  until: string | undefined;
  before: PeriodMeasures;
  after: PeriodMeasures;
  /** Sessions with no start time, in neither period. */
  undated: number;
  /** Size where the sessions after the date compacted on their own. Undefined when they never did. */
  limit: number | undefined;
  /** Window of the replays with no limit. */
  window: number;
  /** Sessions after the date that the replays without the guard continue from the one stopped. */
  chained: number;
  withoutLimit: CompareScenario;
  withoutGuard: CompareScenario;
  withoutBoth: CompareScenario;
}

export interface CompareOptions {
  since: string;
  until?: string | undefined;
  params: CostParams;
  /** Window of the replays with no limit. Default: the largest request of the two periods. */
  window?: number | undefined;
  changedBetween?: ChangeOracle | undefined;
}

const contexts = (session: ProfileSession): readonly SessionContext[] => [session.main, ...session.subagents];
const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

function requestSizes(context: SessionContext): number[] {
  const shape = contextShape(context);
  return Array.from({ length: shape.turns }, (_, index) => shape.size(index + 1));
}

/** The calls that ran a search of recall. A search takes a call of its own, on top of the rent of its result. */
function recallCalls(context: SessionContext, params: CostParams): number {
  const turns = new Set(context.blocks.filter((block) => block.label === RECALL_LABEL).flatMap((block) => block.turn ?? []));
  return sum([...turns].flatMap((turn) => (context.calls[turn - 1] ? weightedCost(context.calls[turn - 1]!.usage, params) : [])));
}

function measure(sessions: readonly ProfileSession[], rereads: ReadonlyMap<string, number>, params: CostParams): PeriodMeasures {
  const sizes = sessions.flatMap((session) => requestSizes(session.main));
  const breakdowns = sessions.map((session) => sessionBreakdown(session, params));
  const items = breakdowns.flatMap((breakdown) => breakdown.items);
  const blocks = sessions.flatMap((session) => contexts(session).flatMap((context) => context.blocks));
  const compactions = sum(sessions.map((session) => session.main.compactions.length));
  const autoCompactions = sum(sessions.map((session) => session.main.autoCompactions?.length ?? 0));
  const costOf = (label: string): number => sum(items.filter((item) => item.label === label).map((item) => item.cost));
  return {
    sessions: sessions.length,
    calls: sum(sessions.flatMap((session) => contexts(session).map((context) => context.calls.length))),
    prompts: sum(sessions.map((session) => session.main.blocks.filter((block) => block.kind === 'prompt' && block.label === 'Prompt').length)),
    cost: sum(breakdowns.map((breakdown) => breakdown.measured)),
    averageContext: sizes.length === 0 ? 0 : sum(sizes) / sizes.length,
    largestContext: Math.max(0, ...sizes),
    cacheRewrites: sum(breakdowns.map((breakdown) => breakdown.cacheRebuilds)),
    autoCompactions,
    manualCompactions: compactions - autoCompactions,
    guardStops: sum(sessions.map((session) => session.guardStops ?? 0)),
    notes: sessions.filter((session) => session.startedFromNote).length,
    recallSearches: blocks.filter((block) => block.label === RECALL_LABEL).length,
    handoffCost: costOf(HANDOFF_LABEL),
    recallCost: costOf(RECALL_LABEL) + sum(sessions.flatMap((session) => contexts(session).map((context) => recallCalls(context, params)))),
    rereadCost: sum(sessions.map((session) => rereads.get(session.sessionId) ?? 0)),
  };
}

/** The size of the request at each automatic compaction of a context, the size of the next one, and what the next one wrote. */
const autoCompactions = (context: SessionContext): { peak: number; left: number; written: number }[] => {
  const sizes = requestSizes(context);
  return (context.autoCompactions ?? []).flatMap((calls) => {
    const next = context.calls[calls];
    return next === undefined ? [] : [{ peak: sizes[calls - 1] ?? 0, left: sizes[calls] ?? 0, written: next.usage.cacheWrite }];
  });
};

/**
 * Compares the sessions started before a date with those started from it on, and estimates what the
 * limit and the guard did on the later ones by replaying their calls without each and without both.
 *
 * Without the guard, a session that started from the note goes on from the session the guard stopped,
 * which assumes the user would have sent the prompt there. The later sessions are replayed in order,
 * so a chain of them carries the size the earlier one reached in the replay.
 */
export function comparePeriods(sessions: readonly ProfileSession[], options: CompareOptions): Comparison {
  const { params } = options;
  const time = (session: ProfileSession): number => Date.parse(session.startedAt ?? '');
  const dated = sessions.filter((session) => !Number.isNaN(time(session))).sort((a, b) => time(a) - time(b));
  const since = Date.parse(options.since);
  const until = options.until === undefined ? Infinity : Date.parse(options.until);
  const before = dated.filter((session) => time(session) < since);
  const after = dated.filter((session) => time(session) >= since && time(session) < until);

  const rereads = new Map<string, number>();
  for (const verdict of judgeReads(dated, params, options.changedBetween)) {
    if (verdict.rediscovery) rereads.set(verdict.sessionId, (rereads.get(verdict.sessionId) ?? 0) + verdict.cost);
  }

  const real = after.flatMap((session) => autoCompactions(session.main));
  const limit = real.length === 0 ? undefined : Math.max(...real.map((compaction) => compaction.peak));
  const largest = Math.max(0, ...[...before, ...after].flatMap((session) => requestSizes(session.main)));
  const window = options.window ?? largest;

  // A compaction keeps more than the prefix and the summary, and costs more than its model: the
  // real ones say by how much. They weigh on the replays, so these use what was measured.
  const { sizes: modelled } = compactionSizes(after.map((session) => sessionBreakdown(session, params)), params);
  const left = median(real.map((compaction) => compaction.left));
  const written = median(real.map((compaction) => compaction.written));
  const sizes = (context: SessionContext): SimulationSizes =>
    left === undefined || written === undefined ? modelled(context) : { prefixTokens: Math.max(0, left - written), summaryTokens: written };
  const compactions = sum(after.map((session) => session.main.compactions.length));
  const unrecorded = sum(after.map((session) => (session.unrecordedUsage ? weightedCost(session.unrecordedUsage, params) : 0)));
  const compactionCost = compactions > 0 && unrecorded > 0 ? unrecorded / compactions : undefined;

  // The limit changed something only if the context went, or could go, past it.
  const raised = limit === undefined || window > limit;

  const stoppedBefore = (session: ProfileSession): ProfileSession | undefined =>
    dated.filter((earlier) => (earlier.guardStops ?? 0) > 0 && time(earlier) < time(session)).at(-1);
  const chain = after.filter((session) => session.startedFromNote && stoppedBefore(session));

  const replay = (replayWindow: number, carry: boolean, keepsLimit: boolean): CompareScenario => {
    const reached = new Map<string, number>();
    const scenario: CompareScenario = { cost: 0, compactions: 0, skipped: 0 };
    for (const session of after) {
      const from = carry && chain.includes(session) ? stoppedBefore(session) : undefined;
      const end = from && (reached.get(from.sessionId) ?? requestSizes(from.main).at(-1) ?? 0);
      const carried = end === undefined ? 0 : Math.max(0, end - (requestSizes(session.main)[0] ?? 0));
      const result = replaySession(
        session,
        params,
        { window: replayWindow, carried, keepsLimit, ...(compactionCost === undefined ? {} : { compactionCost }) },
        sizes,
      );
      reached.set(session.sessionId, result.finalSize);
      scenario.cost += result.simulated;
      scenario.compactions += result.compactions;
      scenario.skipped += result.skipped;
    }
    return scenario;
  };

  return {
    since: options.since,
    until: options.until,
    before: measure(before, rereads, params),
    after: measure(after, rereads, params),
    undated: sessions.length - dated.length,
    limit,
    window,
    chained: chain.length,
    withoutLimit: replay(window, false, raised === false),
    withoutGuard: replay(limit ?? window, true, true),
    withoutBoth: replay(window, true, raised === false),
  };
}
