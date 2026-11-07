import { contextShape, writtenCost } from './breakdown';
import type { CostParams } from './config';
import { weightedCost, writeMultiplier } from './cost';
import type { ProfileSession, SessionContext } from './session';

/** When the simulated agent compacts its context. */
export type CompactionPolicy =
  /** Right before every cache rebuild, while the cache is still warm: compacting before a pause. */
  | { kind: 'before-rebuild' }
  /** At every cache rebuild, before the call goes on: compacting when coming back from a pause. */
  | { kind: 'after-rebuild' }
  /** Whenever a request would be larger than `cap` tokens: a lower auto-compact window. */
  | { kind: 'cap'; cap: number };

export interface Simulation {
  /** Price-weighted cost of the calls as they happened. */
  measured: number;
  /** The same calls with the compactions of the policy, the compactions included. */
  simulated: number;
  /** Compactions the policy added. */
  compactions: number;
}

export interface SimulationSizes {
  /** System prompt, tools and skills: what a compaction keeps besides the summary. */
  prefixTokens: number;
  /** Size of the summary a compaction writes. */
  summaryTokens: number;
}

/**
 * Replays the calls of a context with the compactions of a policy.
 *
 * A compaction leaves the prefix and a summary. The calls after it carry the same new content as the
 * real ones, minus the tokens it removed, which come out of the cached part of each request first and
 * then out of what it wrote. A compaction costs reading the context it summarizes, at the cache-read
 * price when the cache is warm and at the cache-write price when it is cold, plus writing the summary,
 * which the next call then writes to the cache. Real compactions and rewinds reset the context, as
 * they did.
 *
 * Not counted: what the agent loses in a compaction and may have to read again.
 */
export function simulateContext(context: SessionContext, params: CostParams, policy: CompactionPolicy, sizes: SimulationSizes): Simulation {
  const shape = contextShape(context);
  const write = writeMultiplier(context.cacheTtl, params);
  const kept = sizes.prefixTokens + sizes.summaryTokens;
  let removed = 0;
  let simulated = 0;
  let compactions = 0;

  for (let turn = 1; turn <= shape.turns; turn++) {
    const usage = context.calls[turn - 1]!.usage;
    if (shape.startsSegment(turn)) {
      removed = 0;
    } else {
      const rebuild = shape.rebuilt(turn) > 0;
      const compact =
        (policy.kind === 'before-rebuild' && rebuild) ||
        (policy.kind === 'after-rebuild' && rebuild) ||
        (policy.kind === 'cap' && shape.size(turn) - removed > policy.cap);
      const before = shape.size(turn - 1) - removed;
      if (compact && before > kept) {
        const cold = policy.kind === 'after-rebuild';
        simulated += (cold ? write : params.r) * before + params.mu * sizes.summaryTokens;
        // With a warm cache the next call reads the prefix but has to write the new summary.
        if (!rebuild) simulated += (write - params.r) * sizes.summaryTokens;
        removed += before - kept;
        compactions++;
      }
    }

    const cached = Math.max(0, usage.cacheRead - removed);
    const written = Math.max(0, usage.cacheWrite - Math.max(0, removed - usage.cacheRead));
    const writePrice = usage.cacheWrite > 0 ? (writtenCost(usage, params) - usage.input) / usage.cacheWrite : write;
    simulated += usage.input + writePrice * written + params.r * cached + params.mu * usage.output;
  }

  return {
    measured: context.calls.reduce((total, call) => total + weightedCost(call.usage, params), 0),
    simulated,
    compactions,
  };
}

/** A session replayed with a policy: its main context and its subagents. Calls only cost-state records count as they were. */
export function simulateSession(
  session: ProfileSession,
  params: CostParams,
  policy: CompactionPolicy,
  sizes: (context: SessionContext) => SimulationSizes,
): Simulation {
  const parts = [session.main, ...session.subagents].map((context) => simulateContext(context, params, policy, sizes(context)));
  const unrecorded = session.unrecordedUsage ? weightedCost(session.unrecordedUsage, params) : 0;
  return {
    measured: parts.reduce((total, part) => total + part.measured, 0) + unrecorded,
    simulated: parts.reduce((total, part) => total + part.simulated, 0) + unrecorded,
    compactions: parts.reduce((total, part) => total + part.compactions, 0),
  };
}

export interface ReplayOptions {
  /** Auto-compact window of the replay: an automatic compaction under it does not happen, and over it the context compacts. */
  window: number;
  /** Tokens of an earlier session that this one goes on from, instead of starting new. */
  carried?: number;
  /** The window is the real one: a real automatic compaction stays, unless the replay is smaller than the real context there. */
  keepsLimit?: boolean;
  /** What a compaction costs, when there are real ones to measure it on. Default: reading the context and writing the summary. */
  compactionCost?: number;
}

export interface Replay {
  simulated: number;
  /** Compactions the window added. */
  compactions: number;
  /** Real automatic compactions the replay left out. */
  skipped: number;
  /** Size of the last request of the replay. */
  finalSize: number;
}

/**
 * Replays a context with another auto-compact window, or as the continuation of an earlier session.
 * It is the opposite of `simulateContext`, which only takes tokens away: here the tokens stay.
 *
 * The context of the replay differs from the real one by a number of tokens, positive or negative.
 * Where an automatic compaction is left out, what it dropped stays, and the next call reads it all
 * from the cache and writes nothing. Each later call reads the tokens kept, or writes them when its
 * cache had expired. The real compactions the user asked for and the rewinds happen as they did.
 * With the real window and nothing carried, the replay is the context as it ran.
 *
 * Not counted: what the agent would have done differently with more or less context. The call after
 * a compaction left out writes nothing, though it would write the new prompt, so the replay leans
 * towards a lower cost.
 */
export function replayContext(context: SessionContext, params: CostParams, options: ReplayOptions, sizes: SimulationSizes): Replay {
  const shape = contextShape(context);
  const automatic = new Set(context.autoCompactions ?? []);
  const write = writeMultiplier(context.cacheTtl, params);
  const kept = sizes.prefixTokens + sizes.summaryTokens;
  let extra = options.carried ?? 0;
  let simulated = 0;
  let compactions = 0;
  let skipped = 0;

  for (let turn = 1; turn <= shape.turns; turn++) {
    const usage = context.calls[turn - 1]!.usage;
    const before = turn > 1 ? shape.size(turn - 1) + extra : 0;

    const leftOut = turn > 1 && automatic.has(turn - 1) && (options.keepsLimit ? extra < 0 : before <= options.window);
    if (leftOut) {
      extra = before - shape.size(turn);
      skipped++;
      simulated += usage.input + params.r * before + params.mu * usage.output;
      continue;
    }
    if (turn > 1 && shape.startsSegment(turn)) {
      extra = 0;
    } else if (turn > 1 && (!options.keepsLimit || extra > 0) && shape.size(turn) + extra > options.window && before > kept) {
      const compaction = options.compactionCost ?? params.r * before + params.mu * sizes.summaryTokens;
      simulated += compaction + (write - params.r) * sizes.summaryTokens;
      extra = kept - shape.size(turn - 1);
      compactions++;
    }

    const cold = turn === 1 ? extra > 0 : shape.rebuilt(turn) > 0;
    const added = Math.max(0, extra);
    const removed = Math.max(0, -extra);
    const cached = Math.max(0, usage.cacheRead - removed) + (cold ? 0 : added);
    const written = Math.max(0, usage.cacheWrite - Math.max(0, removed - usage.cacheRead)) + (cold ? added : 0);
    const writePrice = usage.cacheWrite > 0 ? (writtenCost(usage, params) - usage.input) / usage.cacheWrite : write;
    simulated += usage.input + writePrice * written + params.r * cached + params.mu * usage.output;
  }

  return { simulated, compactions, skipped, finalSize: shape.turns === 0 ? 0 : shape.size(shape.turns) + extra };
}

/** A session replayed: its main context, its subagents as they ran, and the cost of the compactions that still happen. */
export function replaySession(
  session: ProfileSession,
  params: CostParams,
  options: ReplayOptions,
  sizes: (context: SessionContext) => SimulationSizes,
): Replay {
  const main = replayContext(session.main, params, options, sizes(session.main));
  const subagents = session.subagents.reduce((total, context) => total + context.calls.reduce((sum, call) => sum + weightedCost(call.usage, params), 0), 0);
  const real = session.main.compactions.length;
  const unrecorded = session.unrecordedUsage ? weightedCost(session.unrecordedUsage, params) : 0;
  return { ...main, simulated: main.simulated + subagents + unrecorded * (real === 0 ? 1 : (real - main.skipped) / real) };
}
