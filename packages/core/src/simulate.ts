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
