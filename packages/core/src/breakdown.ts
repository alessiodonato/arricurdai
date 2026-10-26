import type { CostParams } from './config';
import { weightedCost } from './cost';
import type { ProfileSession, SessionBlock, SessionContext } from './session';

/** A part of a session's cost: a block of context with its rent, or a cost that no block carries. */
export interface CostItem {
  /** `tool:Bash`, `memory`, `prefix`, `output`, … */
  group: string;
  label: string;
  /** Tokens the block took in the context, calibrated on the measured growth. 0 for costs that are not blocks. */
  tokens: number;
  /** The API call where the block entered the context. */
  turn: number | undefined;
  /** Calls that read the block again after it entered. */
  turnsKept: number;
  cost: number;
}

export interface Breakdown {
  items: CostItem[];
  /** Price-weighted cost measured from the usage. */
  measured: number;
  /** Calls that wrote the previous context to the cache again instead of reading it. */
  cacheRebuilds: number;
}

/** Real tokens per estimated token are kept between these bounds; what falls outside is reported as unrecorded. */
const MIN_RATIO = 0.5;
const MAX_RATIO = 3;
/** A call counts as a cache rebuild when more than this many tokens of the previous context were not read from the cache. */
const REBUILD_TOKENS = 1024;
/** A request this much smaller than the one before starts a new stretch of context: a rewind, or a compaction. */
const DROP_SHARE = 0.2;
const DROP_TOKENS = 2048;

export const GROUP_LABELS: Record<string, string> = {
  prefix: 'System prompt, tools and skills',
  carried: 'Context carried over a compaction or a rewind',
  memory: 'Memory files',
  injected: 'Text added by Claude Code',
  prompt: 'Your prompts',
  reply: 'Assistant replies and tool calls',
  thinking: 'Assistant thinking',
  summary: 'Compaction summaries',
  unrecorded: 'Context the transcript does not record',
  output: 'Writing output',
  rebuild: 'Cache rebuilt after a pause',
  compaction: 'Compaction calls',
};

export const groupLabel = (group: string): string =>
  group.startsWith('tool:') ? `Tool results: ${group.slice('tool:'.length)}` : GROUP_LABELS[group] ?? group;

const groupOf = (block: SessionBlock): string => (block.kind === 'tool' ? `tool:${block.group}` : block.kind);

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Price of the part of a request that was not read from the cache: input, and cache writes at their TTL. */
export function writtenCost(usage: SessionContext['calls'][number]['usage'], params: CostParams): number {
  const write5m = usage.cacheWrite5m ?? 0;
  const write1h = usage.cacheWrite1h ?? 0;
  const unsplit = Math.max(0, usage.cacheWrite - write5m - write1h);
  return usage.input + params.w * (write5m + unsplit) + params.w1h * write1h;
}

/** Request sizes, stretches of context and cache rebuilds of a context, as its usage shows them. */
export interface ContextShape {
  turns: number;
  /** Tokens of the request of a call: input + cache writes + cache reads. */
  size(turn: number): number;
  /** The call opens a stretch of context: the first call, or the first after a compaction or a large drop in size. */
  startsSegment(turn: number): boolean;
  /** The last call of the stretch of context that holds `turn`. */
  segmentEnd(turn: number): number;
  /** Tokens of the previous request that this call wrote to the cache again instead of reading them; 0 when it is no rebuild. */
  rebuilt(turn: number): number;
}

export function contextShape(context: SessionContext): ContextShape {
  const calls = context.calls;
  const turns = calls.length;
  const size = (turn: number): number => {
    const usage = calls[turn - 1]!.usage;
    return usage.input + usage.cacheWrite + usage.cacheRead;
  };
  // A stretch of context ends at a compaction, or where the request shrinks a lot, as after a rewind.
  const starts = new Set<number>([1]);
  for (let turn = 2; turn <= turns; turn++) {
    const drop = size(turn - 1) - size(turn);
    if (context.compactions.includes(turn - 1) || (drop > DROP_TOKENS && drop > DROP_SHARE * size(turn - 1))) starts.add(turn);
  }
  return {
    turns,
    size,
    startsSegment: (turn) => starts.has(turn),
    segmentEnd: (turn) => {
      let end = turn;
      while (end < turns && !starts.has(end + 1)) end++;
      return end;
    },
    rebuilt: (turn) => {
      if (starts.has(turn)) return 0;
      const missed = size(turn - 1) - calls[turn - 1]!.usage.cacheRead;
      return missed > REBUILD_TOKENS && missed > 0.2 * size(turn - 1) ? missed : 0;
    },
  };
}

interface Placed {
  group: string;
  label: string;
  tokens: number;
  turn: number;
  cost: number;
}

/**
 * Splits the measured cost of one context among the blocks that made it up. The parts add up to the
 * measured cost exactly.
 *
 * Sizes. The size of each request (input + cache writes + cache reads) is measured. Between two
 * calls the context grows by the blocks that entered in between, so their estimated sizes are scaled
 * to that growth; growth the estimates cannot explain is unrecorded context. At the first call, and
 * after each compaction, what the blocks do not explain is the prefix: system prompt, tools, skills.
 *
 * Costs. Each call costs what its usage says. Its cache reads are split among the blocks already in
 * the context, in proportion to their size: that is the rent they pay for staying. At the first call
 * of a context the cache reads go to the prefix first, since it opens the request. What the call
 * writes (input and cache writes) is split among the blocks that just entered. When the cache was
 * rebuilt, the part that wrote the old context again is a cost of its own, and so is the output.
 */
export function contextBreakdown(context: SessionContext, params: CostParams): Breakdown {
  const calls = context.calls;
  const turns = calls.length;
  if (turns === 0) return { items: [], measured: 0, cacheRebuilds: 0 };

  const usage = (turn: number): SessionContext['calls'][number]['usage'] => calls[turn - 1]!.usage;
  const shape = contextShape(context);
  const { size, startsSegment, segmentEnd } = shape;

  const byTurn = new Map<number, SessionBlock[]>();
  for (const block of context.blocks) {
    if (block.turn === undefined || block.turn < 1 || block.turn > turns) continue;
    byTurn.set(block.turn, [...(byTurn.get(block.turn) ?? []), block]);
  }
  const estimated = (turn: number): number => (byTurn.get(turn) ?? []).reduce((total, block) => total + block.tokens, 0);
  const fixed = (turn: number): number => (byTurn.get(turn) ?? []).reduce((total, block) => total + (block.fixedTokens ?? 0), 0);

  // Real tokens per estimated token, from how much the context grew between two calls beyond the tokens already known.
  const ratios: number[] = [];
  for (let turn = 2; turn <= turns; turn++) {
    if (startsSegment(turn)) continue;
    const growth = size(turn) - size(turn - 1) - fixed(turn);
    if (growth > 0 && estimated(turn) > 0) ratios.push(growth / estimated(turn));
  }
  const typicalRatio = clamp(median(ratios) ?? 1, MIN_RATIO, MAX_RATIO);

  // 1. Place every block, with its size calibrated on the measured growth.
  const placed: Placed[] = [];
  const entering = new Map<number, Placed[]>();
  const place = (group: string, label: string, tokens: number, turn: number): Placed => {
    const item = { group, label, tokens, turn, cost: 0 };
    placed.push(item);
    entering.set(turn, [...(entering.get(turn) ?? []), item]);
    return item;
  };
  const prefixes = new Map<number, Placed>();
  for (let turn = 1; turn <= turns; turn++) {
    const estimate = estimated(turn);
    const known = fixed(turn);
    let ratio = typicalRatio;
    if (startsSegment(turn)) {
      const prefix = Math.max(0, size(turn) - estimate * ratio - known);
      const group = turn === 1 ? 'prefix' : 'carried';
      if (prefix > 0) prefixes.set(turn, place(group, GROUP_LABELS[group]!, prefix, turn));
    } else {
      const growth = size(turn) - size(turn - 1);
      if (growth - known > 0 && estimate > 0) ratio = clamp((growth - known) / estimate, MIN_RATIO, MAX_RATIO);
      const unexplained = growth - estimate * ratio - known;
      if (growth > 0 && unexplained > 0) place('unrecorded', GROUP_LABELS.unrecorded!, unexplained, turn);
    }
    for (const block of byTurn.get(turn) ?? []) place(groupOf(block), block.label, block.tokens * ratio + (block.fixedTokens ?? 0), turn);
  }

  // 2. Split the cost of every call.
  let cacheRebuilds = 0;
  let rebuildCost = 0;
  let unassigned = 0;
  let output = 0;
  const present: Placed[] = [];
  let presentTokens = 0;
  for (let turn = 1; turn <= turns; turn++) {
    const u = usage(turn);
    output += params.mu * u.output;
    let reads = params.r * u.cacheRead;
    let writes = writtenCost(u, params);
    const arriving = entering.get(turn) ?? [];

    if (startsSegment(turn)) {
      present.length = 0;
      presentTokens = 0;
      const prefix = prefixes.get(turn);
      if (prefix) {
        // The prefix opens the request, so the cache reads cover it first.
        const cached = Math.min(prefix.tokens, u.cacheRead);
        prefix.cost += params.r * cached;
        reads -= params.r * cached;
      }
    } else {
      const missed = shape.rebuilt(turn);
      if (missed > 0) {
        cacheRebuilds++;
        const notCached = u.input + u.cacheWrite;
        const rebuild = notCached === 0 ? 0 : Math.min(writes, (writes / notCached) * missed);
        rebuildCost += rebuild;
        writes -= rebuild;
      }
      if (presentTokens > 0) {
        for (const item of present) item.cost += (reads * item.tokens) / presentTokens;
        reads = 0;
      }
    }

    // What is left of the reads and the writes goes to the blocks that just entered.
    const opensRequest = (item: Placed): boolean => item.group === 'prefix' || item.group === 'carried';
    const arrivingTokens = arriving.reduce((total, item) => total + (opensRequest(item) ? Math.max(0, item.tokens - u.cacheRead) : item.tokens), 0);
    if (arrivingTokens > 0) {
      for (const item of arriving) {
        const tokens = opensRequest(item) ? Math.max(0, item.tokens - u.cacheRead) : item.tokens;
        item.cost += ((reads + writes) * tokens) / arrivingTokens;
      }
    } else {
      unassigned += reads + writes;
    }
    for (const item of arriving) {
      present.push(item);
      presentTokens += item.tokens;
    }
  }

  const items: CostItem[] = placed.map((item) => ({ ...item, turnsKept: segmentEnd(item.turn) - item.turn }));
  if (unassigned > 0) items.push({ group: 'unrecorded', label: GROUP_LABELS.unrecorded!, tokens: 0, turn: undefined, turnsKept: 0, cost: unassigned });
  if (rebuildCost > 0) items.push({ group: 'rebuild', label: GROUP_LABELS.rebuild!, tokens: 0, turn: undefined, turnsKept: 0, cost: rebuildCost });
  if (output > 0) items.push({ group: 'output', label: GROUP_LABELS.output!, tokens: 0, turn: undefined, turnsKept: 0, cost: output });

  return { items, measured: calls.reduce((total, call) => total + weightedCost(call.usage, params), 0), cacheRebuilds };
}

/** The breakdown of a session: its main context, its subagents, and the calls only cost-state records. */
export function sessionBreakdown(session: ProfileSession, params: CostParams): Breakdown {
  const parts = [session.main, ...session.subagents].map((context) => contextBreakdown(context, params));
  const items = parts.flatMap((part) => part.items);
  let measured = parts.reduce((total, part) => total + part.measured, 0);
  if (session.unrecordedUsage) {
    const cost = weightedCost(session.unrecordedUsage, params);
    measured += cost;
    if (cost > 0) items.push({ group: 'compaction', label: GROUP_LABELS.compaction!, tokens: 0, turn: undefined, turnsKept: 0, cost });
  }
  return { items, measured, cacheRebuilds: parts.reduce((total, part) => total + part.cacheRebuilds, 0) };
}
