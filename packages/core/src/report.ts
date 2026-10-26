import { z } from 'zod';
import { costParamsSchema } from './config';

const share = z.number().min(0);
const count = z.number().int().min(0);
const amount = z.number().min(0);

export const sessionReportSchema = z.object({
  sessionId: z.string(),
  startedAt: z.string().optional(),
  /** API calls of the main context. */
  turns: count,
  /** API calls of its subagents. */
  subagentCalls: count,
  /** K_s, price-weighted tokens, subagents and compaction included. */
  cost: amount,
  /** Cache reads over all input tokens (input + cache writes + cache reads). */
  cacheReadShare: share,
  contextReads: count,
  contextReadTokens: amount,
  rediscoveries: count,
  rediscoveryTokens: amount,
  rediscoveryCost: amount,
  /** Tokens of the memory loaded at the start of the main context. */
  memoryTokens: amount,
  /** Rent of all the memory loaded in the session, at start or on demand. */
  memoryCost: amount,
  compactions: count,
  /** Calls that wrote the previous context to the cache again instead of reading it. */
  cacheRebuilds: count,
});

export const rediscoveryReportSchema = z.object({
  key: z.string(),
  kind: z.enum(['file', 'search', 'list']),
  target: z.string(),
  /** Times it was read again with nothing changed since an earlier session. */
  count: z.number().int().min(1),
  tokens: amount,
  /** Sum of the rent of each rediscovery: c·(w + r·(T − t)). */
  cost: amount,
});

export const memoryFileReportSchema = z.object({
  path: z.string(),
  type: z.string(),
  source: z.enum(['instructions', 'nested']),
  /** Estimated tokens, in the latest session that loaded it. */
  tokens: amount,
  /** Sessions of the window that loaded it. */
  sessions: count,
  /** Rent over those sessions. */
  cost: amount,
});

export const memoryLineReportSchema = z.object({
  /** The memory file, relative to the project root when inside it. */
  file: z.string(),
  /** Line number in the file as loaded. */
  line: z.number().int().min(1),
  text: z.string(),
  terms: z.array(z.string()),
});

export const costGroupSchema = z.object({
  /** `tool:Bash`, `memory`, `prefix`, `output`, … */
  group: z.string(),
  label: z.string(),
  /** Tokens these blocks took in the context, calibrated on the measured growth. */
  tokens: amount,
  cost: amount,
  /** Share of the total cost of the window. */
  share,
});

export const costBlockSchema = z.object({
  sessionId: z.string(),
  group: z.string(),
  label: z.string(),
  tokens: amount,
  /** The API call where the block entered the context. */
  turn: count,
  /** Calls that read it again before it left the context. */
  turnsKept: count,
  cost: amount,
  /** Share of the cost of its session. */
  share,
});

export const reportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  project: z.object({ root: z.string(), transcripts: z.string() }),
  params: costParamsSchema,
  window: z.object({
    /** Sessions measured: the most recent ones. */
    sessions: count,
    /** Sessions available, the older ones used only as history. */
    available: count,
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  summary: z.object({
    sessions: count,
    /** Mean K_s. */
    meanCost: amount,
    totalCost: amount,
    cacheReadShare: share,
    /** Rediscovered tokens over all context-read tokens. */
    rediscoveryShare: share,
    rediscoveryCost: amount,
    /** S_max = Σ rent of rediscoveries / Σ K_s. A ceiling on savings, not a promise. */
    maxSavings: share,
    /** Mean rent per session of the memory loaded at the start. */
    memoryCostPerSession: amount,
    /** Rent of all memory over Σ K_s. */
    memoryShare: share,
  }),
  sessions: z.array(sessionReportSchema),
  /** Grouped by key, most costly first. */
  rediscoveries: z.array(rediscoveryReportSchema),
  memory: z.object({
    files: z.array(memoryFileReportSchema),
    /** Lines with verifiable terms that no session of the window used. */
    unusedLines: z.array(memoryLineReportSchema),
    /** Lines with nothing to check, such as style rules in prose. */
    unverifiableLines: z.array(memoryLineReportSchema),
    usedLines: count,
  }),
  /** Where the cost goes: the blocks of context that carry it, by group and one by one. */
  breakdown: z.object({
    groups: z.array(costGroupSchema),
    /** The most costly blocks of the window. */
    topBlocks: z.array(costBlockSchema),
    /** Share of the measured cost that the breakdown explains. */
    explained: share,
    cacheRebuilds: count,
  }),
  /** The same sessions replayed with compactions at other moments. A ceiling: what the agent loses in a compaction is not counted. */
  whatIf: z.object({
    /** Size of the summary a simulated compaction writes: the median of the real ones, or a default. */
    summaryTokens: amount,
    scenarios: z.array(z.object({
      /** `before-rebuild`: before every pause; `after-rebuild`: when coming back; `cap`: whenever a request passes `cap` tokens. */
      policy: z.enum(['before-rebuild', 'after-rebuild', 'cap']),
      cap: z.number().int().positive().optional(),
      /** Measured cost minus simulated cost. Negative when the compactions cost more than they save. */
      saving: z.number(),
      share: z.number(),
      compactions: count,
    })),
  }),
  /** What makes some numbers approximate, in plain words. */
  approximations: z.array(z.string()),
  lines: z.object({
    total: count,
    malformed: count,
    unknownTypes: z.record(z.string(), count),
    invalid: z.record(z.string(), count),
    orphanResults: count,
  }),
});

export type Report = z.infer<typeof reportSchema>;
export type SessionReport = z.infer<typeof sessionReportSchema>;
export type RediscoveryReport = z.infer<typeof rediscoveryReportSchema>;
export type MemoryFileReport = z.infer<typeof memoryFileReportSchema>;
export type MemoryLineReport = z.infer<typeof memoryLineReportSchema>;
export type CostGroupReport = z.infer<typeof costGroupSchema>;
export type CostBlockReport = z.infer<typeof costBlockSchema>;
