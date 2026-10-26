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
