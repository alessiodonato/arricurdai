import type {
  CacheTtl,
  ProfileSession,
  SessionChange,
  SessionContext,
  SessionMemory,
  SessionRead,
  Usage,
} from '@arricurdai/core';
import type { ReadTarget } from './reads';

/** One API call: one distinct `message.id` in the assistant lines. */
export interface Call {
  /** Position in its context, from 1. */
  index: number;
  messageId: string;
  timestamp: string | undefined;
  model: string | undefined;
  usage: Usage;
}

/** A context read: a tool result that brought existing context into the conversation. */
export interface ContextRead extends ReadTarget, SessionRead {
  /** Matches the same read across sessions. */
  key: string;
  /** Estimated tokens that entered the context. A command that reads several targets splits its result evenly. */
  tokens: number;
  /** Hash of the whole tool result, to tell an identical result from a changed one. */
  resultHash: string;
  /** The API call where the result entered the context (t). Undefined when no call followed. */
  turn: number | undefined;
  timestamp: string | undefined;
  toolUseId: string;
  /** The output was saved to disk and only a preview entered the context. */
  persisted: boolean;
  /** The call failed, for example because permission was denied. */
  isError: boolean;
}

/** A memory file that Claude Code put into the context. */
export interface MemoryLoad extends SessionMemory {
  path: string;
  /** `Project`, `Local`, `User`, `AutoMem`, … as Claude Code records it. */
  type: string;
  content: string;
  tokens: number;
  /** `instructions`: loaded when the session starts. `nested`: loaded on the first read in its folder. */
  source: 'instructions' | 'nested';
  /** The API call where it entered the context. Undefined when no call followed. */
  turn: number | undefined;
  timestamp: string | undefined;
}

/** A file written by a tool call that succeeded. */
export interface FileChange extends SessionChange {
  /** Relative to the project root, or absolute when outside it. */
  path: string;
  tool: string;
  timestamp: string | undefined;
}

/** A conversation context: the main session, or one subagent. */
export interface Context extends SessionContext {
  kind: 'main' | 'subagent';
  agentId: string | undefined;
  agentType: string | undefined;
  /** The parent's Agent call that started this subagent. */
  parentToolUseId: string | undefined;
  calls: Call[];
  /** For each compaction, the number of calls before it. */
  compactions: number[];
  reads: ContextRead[];
  memory: MemoryLoad[];
  /** The cache TTL that most of this context's writes used. `5m` when the transcript does not say. */
  cacheTtl: CacheTtl;
}

/** Counts of the lines read, by what happened to them. */
export interface LineStats {
  lines: number;
  empty: number;
  malformedJson: number;
  notObject: number;
  /** Known line types that the profiler does not need. */
  ignored: number;
  /** Line types the parser does not know, by type. */
  unknownTypes: Record<string, number>;
  /** Known line types with fields the parser cannot use, by type. */
  invalid: Record<string, number>;
  /** Tool results with no matching tool call. */
  orphanResults: number;
}

export interface ParsedSession extends ProfileSession {
  sessionId: string;
  file: string;
  /** Absolute folder that paths are relative to: the option, or the session's first `cwd`. */
  root: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  versions: string[];
  entrypoint: string | undefined;
  main: Context;
  subagents: Context[];
  fileChanges: FileChange[];
  /** What the agent wrote: assistant messages and the strings in its tool calls. */
  agentText: string[];
  /** Totals from the last `cost-state` line. */
  costState: Usage | undefined;
  /** Usage in `cost-state` that no assistant line records, such as compaction calls. */
  unrecordedUsage: Usage | undefined;
  /** The main transcript has attachment lines, so it records which memory files were loaded. */
  recordsMemory: boolean;
  stats: LineStats;
}

export interface ParsedProject {
  dir: string;
  /** Sorted by start time. */
  sessions: ParsedSession[];
  stats: LineStats;
  /** API calls whose `message.id` already appeared in an earlier session. */
  duplicateCalls: number;
}
