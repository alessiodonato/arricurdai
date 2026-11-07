import { type Comparison, comparePeriods, type PeriodMeasures } from '@arricurdai/core';
import { parseProject } from '@arricurdai/transcripts';
import { createColors } from 'picocolors';
import { loadGitHistory } from './git';
import { formatInteger, formatPercent } from './render';
import { type CommandIO, type ProjectOptions, resolveProject, UserError, withErrors } from './run-profile';

export interface CompareCommandOptions extends ProjectOptions {
  since?: string;
  until?: string;
  window?: string;
  json?: boolean;
}

/** Below this many calls on a side, one session can move the numbers a lot. */
const FEW_CALLS = 500;

function date(value: string, option: string): string {
  if (Number.isNaN(Date.parse(value))) throw new UserError(`${option} must be a date such as 2026-10-26, got "${value}"`);
  return value;
}

function window(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < 1) throw new UserError(`--window must be a whole number of tokens, got "${value}"`);
  return tokens;
}

/** Builds the comparison of a project. Throws UserError for problems the user can fix. */
export async function buildComparison(options: CompareCommandOptions, io: Pick<CommandIO, 'cwd' | 'env'>): Promise<Comparison> {
  if (options.since === undefined) throw new UserError('--since is required: the day something changed, such as 2026-10-26');
  const since = date(options.since, '--since');
  const until = options.until === undefined ? undefined : date(options.until, '--until');
  const replayWindow = window(options.window);
  const { projectRoot, transcripts, params } = await resolveProject(options, io);
  const project = await parseProject(transcripts);
  const git = await loadGitHistory(projectRoot, project.sessions[0]?.startedAt);
  const comparison = comparePeriods(project.sessions, { since, until, params, window: replayWindow, changedBetween: git?.changedBetween });
  if (comparison.before.sessions === 0) throw new UserError(`no sessions started before ${since}, so there is nothing to compare with`);
  if (comparison.after.sessions === 0) throw new UserError(`no sessions started from ${since} on, so there is nothing to compare`);
  return comparison;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
const decimal = (value: number): string => value.toFixed(1);

/** A change as a signed percentage, or nothing when there is nothing to compare it with. */
function change(from: number, to: number): string {
  if (from === 0) return '';
  const share = (to - from) / from;
  return `${share < 0 ? '−' : '+'}${formatPercent(Math.abs(share))}`;
}

const cell = (text: string, width: number): string => text.padStart(width);
const count = (value: number, one: string, many: string): string => `${formatInteger(value)} ${value === 1 ? one : many}`;

function periodRows({ before, after }: Comparison): [string, string, string, string][] {
  const row = (label: string, value: (period: PeriodMeasures) => number, format: (value: number) => string = formatInteger, trend = true): [string, string, string, string] => [
    label,
    format(value(before)),
    format(value(after)),
    trend ? change(value(before), value(after)) : '',
  ];
  return [
    row('Sessions', (period) => period.sessions, formatInteger, false),
    row('Calls', (period) => period.calls, formatInteger, false),
    row('Prompts', (period) => period.prompts, formatInteger, false),
    row('Cost per call', (period) => ratio(period.cost, period.calls)),
    row('Cost per prompt', (period) => ratio(period.cost, period.prompts)),
    row('Calls per prompt', (period) => ratio(period.calls, period.prompts), decimal),
    row('Average context', (period) => period.averageContext),
    row('Largest context', (period) => period.largestContext),
    row('Cache rewrites', (period) => period.cacheRewrites, formatInteger, false),
    row('Automatic compactions', (period) => period.autoCompactions, formatInteger, false),
    row('Compactions you asked for', (period) => period.manualCompactions, formatInteger, false),
    row('Read again, share of cost', (period) => ratio(period.rereadCost, period.cost), formatPercent, false),
  ];
}

/** The comparison for the terminal: the two periods, what each part did, what arricurdAI added, and how to read it. */
export function renderComparison(comparison: Comparison, options: { colors: boolean }): string {
  const c = createColors(options.colors);
  const { before, after, limit, window: replayWindow, chained, withoutLimit, withoutGuard, withoutBoth } = comparison;
  const period = comparison.until === undefined ? `from ${comparison.since} on` : `from ${comparison.since} to ${comparison.until}`;
  const lines: string[] = [c.bold('arricurdAI compare'), `Sessions started before ${comparison.since}, and ${period}. Costs are price-weighted tokens, as in profile.`, ''];

  lines.push(`${''.padEnd(28)}${cell('Before', 12)}${cell('After', 12)}${cell('Change', 9)}`);
  for (const [label, first, second, trend] of periodRows(comparison)) {
    lines.push(`${label.padEnd(28)}${cell(first, 12)}${cell(second, 12)}${cell(trend, 9)}`);
  }

  lines.push('', c.bold('What each part did on the later sessions'), 'Estimates: the same calls replayed, as if the work had stayed the same.', '');
  const scenario = (label: string, cost: number, why: string): string =>
    `${label.padEnd(28)}${cell(formatInteger(cost), 12)}${cell(change(after.cost, cost), 12)}  ${c.dim(why)}`;
  lines.push(`${'As they ran'.padEnd(28)}${cell(formatInteger(after.cost), 12)}`);
  lines.push(
    scenario(
      'Without the limit',
      withoutLimit.cost,
      limit === undefined ? 'no automatic compaction in these sessions' : `${count(withoutLimit.skipped, 'compaction', 'compactions')} at up to ${formatInteger(limit)} left out, window ${formatInteger(replayWindow)}`,
    ),
  );
  lines.push(scenario('Without the guard', withoutGuard.cost, chained === 0 ? 'no session started from the note' : count(chained, 'session goes on from the one stopped', 'sessions go on from the one stopped')));
  lines.push(scenario('Without both', withoutBoth.cost, ''));
  lines.push(`${'Per call, without both'.padEnd(28)}${cell(formatInteger(ratio(withoutBoth.cost, after.calls)), 12)}${cell('', 12)}  ${c.dim(`before: ${formatInteger(ratio(before.cost, before.calls))}`)}`);

  lines.push('', c.bold('What arricurdAI added on the later sessions'), '');
  lines.push(`${'Prompts stopped'.padEnd(28)}${cell(formatInteger(after.guardStops), 12)}`);
  lines.push(`${'Notes and search hint'.padEnd(28)}${cell(formatPercent(ratio(after.handoffCost, after.cost)), 12)}  ${c.dim(`of the cost, ${count(after.notes, 'note', 'notes')}`)}`);
  lines.push(`${'Searches with recall'.padEnd(28)}${cell(formatPercent(ratio(after.recallCost, after.cost)), 12)}  ${c.dim(`of the cost, ${count(after.recallSearches, 'search', 'searches')}`)}`);

  lines.push('', c.bold('How to read this'));
  lines.push('- The two periods hold different work, so the change is a comparison, not an experiment.');
  lines.push('- Part of the saving can come from one setting: a lower auto-compact window works without arricurdAI.');
  if (chained > 0) lines.push('- Without the guard assumes you would have sent each stopped prompt in the old session.');
  lines.push('- Without both is the roughest: it keeps only the compactions that really happened, and you might have asked for more.');
  if (after.recallSearches > 0) lines.push('- A transcript shows what recall cost, not what it saved. Read again shows the price of a smaller context.');
  lines.push('- A session counts in the period where it started.');
  if (Math.min(before.calls, after.calls) < FEW_CALLS) lines.push(`- Few calls: under ${FEW_CALLS} on a side, one session can move these numbers a lot.`);
  if (comparison.undated > 0) lines.push(`- ${count(comparison.undated, 'session has', 'sessions have')} no start time: left out.`);
  return `${lines.join('\n')}\n`;
}

/** Runs `arricurdai compare` and returns the exit code. Never throws. */
export function runCompare(options: CompareCommandOptions, io: CommandIO): Promise<number> {
  return withErrors(io, async () => {
    const comparison = await buildComparison(options, io);
    io.stdout(options.json ? `${JSON.stringify(comparison, null, 2)}\n` : renderComparison(comparison, { colors: io.colors }));
  });
}
