import type { CacheTtl, Usage } from './cost';

// The minimal shape of a parsed project that the measures need.
// @arricurdai/transcripts produces objects that extend these interfaces.

export type ReadKind = 'file' | 'search' | 'list';

/** A tool result that brought context into the conversation. */
export interface SessionRead {
  /** Matches the same read across sessions. */
  key: string;
  kind: ReadKind;
  /** file: the path relative to the project root. search: the pattern. list: the folders. */
  target: string;
  scope?: string | undefined;
  tokens: number;
  /** Hash of the tool result, to tell an identical result from a changed one. */
  resultHash: string;
  /** The API call where the result entered the context (t). */
  turn: number | undefined;
  timestamp: string | undefined;
  isError: boolean;
}

export interface SessionMemory {
  path: string;
  type: string;
  content: string;
  tokens: number;
  /** `instructions`: loaded when the session starts. `nested`: loaded on demand. */
  source: 'instructions' | 'nested';
  turn: number | undefined;
}

/** What a block of context is, for the cost breakdown. */
export type BlockKind = 'prompt' | 'reply' | 'thinking' | 'tool' | 'memory' | 'injected' | 'summary';

/** A block that entered the context: a reply, a tool result, a prompt, memory, or text Claude Code added. */
export interface SessionBlock {
  kind: BlockKind;
  /** Finer grouping: the tool family for tool results (`Read`, `Bash`, …), the attachment type for injected text. */
  group: string;
  /** Short description, such as `Read src/app.ts` or `Bash: npm test`. Never the content itself. */
  label: string;
  /** Estimated tokens of its text (characters / 4). The cost breakdown calibrates them on the measured growth. */
  tokens: number;
  /** Tokens known without estimating the text: thinking from the usage, images from their size. Not calibrated. */
  fixedTokens?: number;
  /** The API call where it entered the context. */
  turn: number | undefined;
}

export interface SessionContext {
  kind: 'main' | 'subagent';
  calls: readonly { usage: Usage }[];
  /** For each compaction, the number of calls before it. */
  compactions: readonly number[];
  reads: readonly SessionRead[];
  memory: readonly SessionMemory[];
  /** Every block that entered the context, in order. */
  blocks: readonly SessionBlock[];
  cacheTtl: CacheTtl;
}

export interface SessionChange {
  /** Relative to the project root, or absolute when outside it. */
  path: string;
  timestamp: string | undefined;
}

export interface ProfileSession {
  sessionId: string;
  startedAt: string | undefined;
  /** Absolute folder that paths are relative to. */
  root: string;
  main: SessionContext;
  subagents: readonly SessionContext[];
  fileChanges: readonly SessionChange[];
  /** Assistant messages and the strings in the agent's tool calls. */
  agentText: readonly string[];
  /** Usage that only the session totals record, such as compaction calls. */
  unrecordedUsage: Usage | undefined;
  /** The transcript records which memory files were loaded (attachment lines). */
  recordsMemory: boolean;
}

export interface LineStatsInput {
  lines: number;
  empty: number;
  malformedJson: number;
  notObject: number;
  ignored: number;
  unknownTypes: Record<string, number>;
  invalid: Record<string, number>;
  orphanResults: number;
}

export interface ProfileInput {
  /** The transcript folder. */
  dir: string;
  sessions: readonly ProfileSession[];
  stats: LineStatsInput;
  /** API calls whose id already appeared in an earlier session. */
  duplicateCalls: number;
}
