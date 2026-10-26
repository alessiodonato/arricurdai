import { posix } from 'node:path';
import { type Breakdown, contextBreakdown, groupLabel, sessionBreakdown } from './breakdown';
import { type CostParams, DEFAULT_COST_PARAMS } from './config';
import { maxSavings, sumUsage, weightedCost } from './cost';
import { classifyMemoryLines, type MemoryCost, type MemoryDocument, type MemoryLine, memoryLoadCosts } from './memory';
import { type ChangeOracle, judgeReads, type ReadVerdict } from './rediscovery';
import {
  type CostBlockReport,
  type CostGroupReport,
  type MemoryFileReport,
  type RediscoveryReport,
  type Report,
  reportSchema,
  type SessionReport,
} from './report';
import type { ProfileInput, ProfileSession, SessionContext, SessionMemory } from './session';
import { type CompactionPolicy, simulateSession } from './simulate';
import { estimateTokens } from './tokens';

export const DEFAULT_SESSION_WINDOW = 20;

/** A memory file read from disk, for sessions whose transcript does not record memory. */
export interface DiskMemoryFile {
  path: string;
  type: string;
  content: string;
}

export interface ProfileOptions {
  /** Absolute path of the project, as the user gave it. */
  projectRoot: string;
  /** ISO time written in the report. */
  generatedAt: string;
  params?: CostParams;
  /** How many of the most recent sessions to measure. Older sessions only serve as history. */
  sessions?: number;
  /** Says whether a file changed between two times, from git. Leave it out when there is no git history. */
  changedBetween?: ChangeOracle;
  /** Memory files found on disk now. */
  diskMemory?: readonly DiskMemoryFile[];
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** `n` followed by the singular or the plural form. */
const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const byStart = (a: ProfileSession, b: ProfileSession): number =>
  (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿');

function relativeTo(root: string, path: string): string {
  if (!path.startsWith('/')) return path;
  const relative = posix.relative(root, path);
  if (relative === '') return '.';
  return relative.startsWith('..') ? path : relative;
}

function withDiskMemory(session: ProfileSession, files: readonly DiskMemoryFile[]): ProfileSession {
  const memory: SessionMemory[] = files.map((file) => ({
    path: file.path, type: file.type, content: file.content, tokens: estimateTokens(file.content), source: 'instructions', turn: 1,
  }));
  return { ...session, main: { ...session.main, memory: [...memory, ...session.main.memory] } };
}

interface SessionMeasure {
  session: ProfileSession;
  report: SessionReport;
  cacheRead: number;
  inputSide: number;
  memory: MemoryCost[];
  breakdown: Breakdown;
}

function measureSession(session: ProfileSession, verdicts: readonly ReadVerdict[], params: CostParams): SessionMeasure {
  const contexts = [session.main, ...session.subagents];
  const usage = sumUsage([
    ...contexts.flatMap((context) => context.calls.map((call) => call.usage)),
    ...(session.unrecordedUsage ? [session.unrecordedUsage] : []),
  ]);
  const inputSide = usage.input + usage.cacheWrite + usage.cacheRead;
  const rediscovered = verdicts.filter((verdict) => verdict.rediscovery);
  const memory = contexts.flatMap((context) => memoryLoadCosts(context, params));
  const startMemory = new Map(session.main.memory.filter((load) => load.source === 'instructions').map((load) => [load.path, load.tokens]));
  const breakdown = sessionBreakdown(session, params);

  return {
    session,
    cacheRead: usage.cacheRead,
    inputSide,
    memory,
    breakdown,
    report: {
      sessionId: session.sessionId,
      ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
      turns: session.main.calls.length,
      subagentCalls: sum(session.subagents.map((context) => context.calls.length)),
      cost: weightedCost(usage, params),
      cacheReadShare: inputSide === 0 ? 0 : usage.cacheRead / inputSide,
      contextReads: verdicts.length,
      contextReadTokens: sum(verdicts.map((verdict) => verdict.read.tokens)),
      rediscoveries: rediscovered.length,
      rediscoveryTokens: sum(rediscovered.map((verdict) => verdict.read.tokens)),
      rediscoveryCost: sum(rediscovered.map((verdict) => verdict.cost)),
      memoryTokens: sum([...startMemory.values()]),
      memoryCost: sum(memory.map((load) => load.cost)),
      compactions: sum(contexts.map((context) => context.compactions.length)),
      cacheRebuilds: breakdown.cacheRebuilds,
    },
  };
}

const TOP_BLOCKS = 10;
/** Context sizes tried as a lower auto-compact window. */
const CAPS = [200_000, 400_000];
/** Summary size when the sessions have no real compaction to measure. */
const DEFAULT_SUMMARY_TOKENS = 15_000;

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Replays the window with compactions before pauses, after pauses, and under a few context sizes. */
function whatIf(measures: readonly SessionMeasure[], params: CostParams): Report['whatIf'] {
  const total = sum(measures.map((measure) => measure.report.cost));
  const summaries = measures.flatMap((measure) => measure.breakdown.items.filter((item) => item.group === 'summary').map((item) => item.tokens));
  const summaryTokens = Math.round(median(summaries) ?? DEFAULT_SUMMARY_TOKENS);
  const prefixes = new Map<SessionContext, number>();
  const sizes = (context: SessionContext) => {
    let prefixTokens = prefixes.get(context);
    if (prefixTokens === undefined) {
      prefixTokens = contextBreakdown(context, params).items.find((item) => item.group === 'prefix' && item.turn === 1)?.tokens ?? 0;
      prefixes.set(context, prefixTokens);
    }
    return { prefixTokens, summaryTokens };
  };

  const largest = Math.max(0, ...measures.flatMap(({ session }) =>
    [session.main, ...session.subagents].flatMap((context) => context.calls.map((call) => call.usage.input + call.usage.cacheWrite + call.usage.cacheRead))));
  const policies: CompactionPolicy[] = [
    ...(measures.some((measure) => measure.breakdown.cacheRebuilds > 0) ? [{ kind: 'before-rebuild' as const }, { kind: 'after-rebuild' as const }] : []),
    ...CAPS.filter((cap) => cap < largest).map((cap) => ({ kind: 'cap' as const, cap })),
  ];

  const scenarios = policies.map((policy) => {
    let saving = 0;
    let compactions = 0;
    for (const { session } of measures) {
      const result = simulateSession(session, params, policy, sizes);
      saving += result.measured - result.simulated;
      compactions += result.compactions;
    }
    return { policy: policy.kind, ...(policy.kind === 'cap' ? { cap: policy.cap } : {}), saving, share: total === 0 ? 0 : saving / total, compactions };
  });
  return { summaryTokens, scenarios };
}

/** Groups the cost items of the window, and picks its most costly blocks. */
function summarizeBreakdown(measures: readonly SessionMeasure[]): Report['breakdown'] {
  const total = sum(measures.map((measure) => measure.report.cost));
  const groups = new Map<string, CostGroupReport>();
  const blocks: CostBlockReport[] = [];
  for (const { session, report, breakdown } of measures) {
    for (const item of breakdown.items) {
      const group = groups.get(item.group) ?? { group: item.group, label: groupLabel(item.group), tokens: 0, cost: 0, share: 0 };
      group.tokens += item.tokens;
      group.cost += item.cost;
      groups.set(item.group, group);
      if (item.turn !== undefined && item.tokens > 0) {
        blocks.push({
          sessionId: session.sessionId, group: item.group, label: item.label, tokens: item.tokens, turn: item.turn,
          turnsKept: item.turnsKept, cost: item.cost, share: report.cost === 0 ? 0 : item.cost / report.cost,
        });
      }
    }
  }
  // Everything but the context the transcript does not record is explained by a known block or cost.
  const unrecorded = groups.get('unrecorded')?.cost ?? 0;
  return {
    groups: [...groups.values()].map((group) => ({ ...group, share: total === 0 ? 0 : group.cost / total })).sort((a, b) => b.cost - a.cost),
    topBlocks: blocks.sort((a, b) => b.cost - a.cost).slice(0, TOP_BLOCKS),
    explained: total === 0 ? 0 : Math.max(0, 1 - unrecorded / total),
    cacheRebuilds: sum(measures.map((measure) => measure.breakdown.cacheRebuilds)),
  };
}

function groupRediscoveries(verdicts: readonly ReadVerdict[]): RediscoveryReport[] {
  const groups = new Map<string, RediscoveryReport>();
  for (const { read, cost, rediscovery } of verdicts) {
    if (!rediscovery) continue;
    const group = groups.get(read.key) ?? { key: read.key, kind: read.kind, target: read.target, count: 0, tokens: 0, cost: 0 };
    group.count++;
    group.tokens += read.tokens;
    group.cost += cost;
    groups.set(read.key, group);
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}

function groupMemory(measures: readonly SessionMeasure[], root: string): MemoryFileReport[] {
  const files = new Map<string, MemoryFileReport & { seenIn: Set<string> }>();
  for (const { session, memory } of measures) {
    for (const load of memory) {
      const id = `${load.source}:${load.path}`;
      const file = files.get(id) ?? { path: relativeTo(root, load.path), type: load.type, source: load.source, tokens: 0, sessions: 0, cost: 0, seenIn: new Set<string>() };
      file.tokens = load.tokens;
      file.cost += load.cost;
      file.seenIn.add(session.sessionId);
      file.sessions = file.seenIn.size;
      files.set(id, file);
    }
  }
  return [...files.values()].map(({ seenIn: _, ...file }) => file).sort((a, b) => b.cost - a.cost || a.path.localeCompare(b.path));
}

/** Every memory file loaded in the window: its latest content, and the sessions that loaded it. */
function latestMemoryFiles(sessions: readonly ProfileSession[], root: string): MemoryDocument[] {
  const latest = new Map<string, { content: string; loadedIn: Set<string> }>();
  for (const session of sessions) {
    for (const context of [session.main, ...session.subagents]) {
      for (const load of context.memory) {
        const document = latest.get(load.path) ?? { content: load.content, loadedIn: new Set<string>() };
        document.content = load.content;
        document.loadedIn.add(session.sessionId);
        latest.set(load.path, document);
      }
    }
  }
  return [...latest].map(([path, { content, loadedIn }]) => ({ file: relativeTo(root, path), content, loadedIn }));
}

const toLineReport = ({ file, line, text, terms }: MemoryLine) => ({ file, line, text, terms });

/**
 * Measures a project from its parsed sessions:
 * - the price-weighted cost K_s of each session;
 * - the context it rediscovered, and the rent paid for it;
 * - the rent of the memory loaded in every session;
 * - the memory lines that no session used;
 * - S_max, the ceiling on savings.
 *
 * Only the most recent `options.sessions` sessions are measured. All sessions serve as history.
 */
export function profile(input: ProfileInput, options: ProfileOptions): Report {
  const params = options.params ?? DEFAULT_COST_PARAMS;
  const windowSize = Math.max(0, Math.floor(options.sessions ?? DEFAULT_SESSION_WINDOW));

  const rebuilt = new Set<string>();
  const all = [...input.sessions].sort(byStart).map((session) => {
    if (session.recordsMemory || !options.diskMemory?.length) return session;
    rebuilt.add(session.sessionId);
    return withDiskMemory(session, options.diskMemory);
  });
  const window = windowSize === 0 ? [] : all.slice(-windowSize);
  const inWindow = new Set(window.map((session) => session.sessionId));
  const root = window.at(-1)?.root ?? options.projectRoot;

  const verdicts = judgeReads(all, params, options.changedBetween).filter((verdict) => inWindow.has(verdict.sessionId));
  const measures = window.map((session) => measureSession(session, verdicts.filter((verdict) => verdict.sessionId === session.sessionId), params));
  const sessions = measures.map((measure) => measure.report);

  const totalCost = sum(sessions.map((session) => session.cost));
  const readTokens = sum(sessions.map((session) => session.contextReadTokens));
  const inputSide = sum(measures.map((measure) => measure.inputSide));
  const startMemoryCost = sum(measures.flatMap((measure) => measure.memory.filter((load) => load.source === 'instructions').map((load) => load.cost)));
  const lines = classifyMemoryLines(latestMemoryFiles(window, root), window);

  const approximations: string[] = [];
  if (!options.changedBetween) {
    approximations.push('The project has no git history, so only the file changes made through Claude Code are seen. A file edited outside it can count as a rediscovery.');
  }
  const unchecked = verdicts.filter((verdict) => verdict.unchecked).length;
  if (options.changedBetween && unchecked > 0) {
    approximations.push(`${counted(unchecked, 'rediscovered file', 'rediscovered files')} could not be checked against git, because ${unchecked === 1 ? 'it is' : 'they are'} outside the repository.`);
  }
  const rebuiltInWindow = window.filter((session) => rebuilt.has(session.sessionId)).length;
  if (rebuiltInWindow > 0) {
    const one = rebuiltInWindow === 1;
    approximations.push(`${counted(rebuiltInWindow, 'session does', 'sessions do')} not record which memory files ${one ? 'it' : 'they'} loaded. ${one ? 'Its' : 'Their'} memory was rebuilt from the files on disk today.`);
  }
  if (input.duplicateCalls > 0) {
    const one = input.duplicateCalls === 1;
    approximations.push(`${counted(input.duplicateCalls, 'API call appears', 'API calls appear')} in more than one session, for example after a fork. ${one ? 'Its' : 'Their'} cost may be counted twice.`);
  }

  return reportSchema.parse({
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    project: { root: options.projectRoot, transcripts: input.dir },
    params,
    window: { sessions: window.length, available: all.length, from: window[0]?.startedAt, to: window.at(-1)?.startedAt },
    summary: {
      sessions: window.length,
      meanCost: window.length === 0 ? 0 : totalCost / window.length,
      totalCost,
      cacheReadShare: inputSide === 0 ? 0 : sum(measures.map((measure) => measure.cacheRead)) / inputSide,
      rediscoveryShare: readTokens === 0 ? 0 : sum(sessions.map((session) => session.rediscoveryTokens)) / readTokens,
      rediscoveryCost: sum(sessions.map((session) => session.rediscoveryCost)),
      maxSavings: maxSavings(sessions.map((session) => session.rediscoveryCost), sessions.map((session) => session.cost)),
      memoryCostPerSession: window.length === 0 ? 0 : startMemoryCost / window.length,
      memoryShare: totalCost === 0 ? 0 : sum(sessions.map((session) => session.memoryCost)) / totalCost,
    },
    sessions,
    rediscoveries: groupRediscoveries(verdicts),
    memory: {
      files: groupMemory(measures, root),
      unusedLines: lines.unused.map(toLineReport),
      unverifiableLines: lines.unverifiable.map(toLineReport),
      usedLines: lines.used.length,
    },
    breakdown: summarizeBreakdown(measures),
    whatIf: whatIf(measures, params),
    approximations,
    lines: {
      total: input.stats.lines,
      malformed: input.stats.malformedJson + input.stats.notObject,
      unknownTypes: input.stats.unknownTypes,
      invalid: input.stats.invalid,
      orphanResults: input.stats.orphanResults,
    },
  });
}
