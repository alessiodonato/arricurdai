import type { Report } from '@arricurdai/core';
import { createColors } from 'picocolors';

export interface RenderOptions {
  colors: boolean;
  /** Home folder, shown as `~` in paths. */
  home?: string | undefined;
  /** Most unused memory lines to list before pointing to --json. */
  maxLines?: number;
}

const TOP_REDISCOVERIES = 10;
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const formatInteger = (value: number): string => integer.format(Math.round(value));

/** A share as a percentage: two decimals under 1%, one under 10%, none above. */
export function formatPercent(share: number): string {
  const value = share * 100;
  if (value === 0) return '0%';
  const digits = value < 1 ? 2 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)}%`;
}

const truncate = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);
const day = (iso: string | undefined): string => iso?.slice(0, 10) ?? '?';

function shortenPath(path: string, home: string | undefined): string {
  if (!home || home === '/') return path;
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function rediscoveryLabel({ kind, key, target }: Report['rediscoveries'][number]): string {
  if (kind === 'file') return target;
  return `${kind} ${key.slice(kind.length + 1)}`;
}

/**
 * The terminal report, in three parts: the summary, the most costly rediscoveries, and the memory
 * lines never used. The summary ends with what makes the numbers approximate and the lines skipped.
 */
export function renderReport(report: Report, options: RenderOptions): string {
  const c = createColors(options.colors);
  const short = (path: string): string => shortenPath(path, options.home);
  const { summary, window } = report;
  const out: string[] = [];
  const row = (label: string, value: string): void => {
    out.push(`  ${label.padEnd(24)}${value}`);
  };

  out.push(c.bold(`arricurdai profile · ${short(report.project.root)}`));
  out.push(c.dim(`Transcripts: ${short(report.project.transcripts)}`));
  out.push('');

  // 1. Summary
  out.push(c.bold('Summary'));
  const range = window.from ? `  ${c.dim(`${day(window.from)} → ${day(window.to)}`)}` : '';
  const older = window.available > window.sessions ? ` of ${window.available}` : '';
  row('Sessions analyzed', `${window.sessions}${older}${range}`);
  row('Mean cost K', `${formatInteger(summary.meanCost)} ${c.dim('price-weighted tokens per session')}`);
  row('Read from cache', `${formatPercent(summary.cacheReadShare)} ${c.dim('of input tokens')}`);
  row('Rediscovery', `${formatPercent(summary.rediscoveryShare)} ${c.dim('of the tokens read as context')}`);
  row('S_max', `${c.bold(formatPercent(summary.maxSavings))} ${c.dim('of the cost: a ceiling on savings, not a promise')}`);
  const sessionsWithMemory = report.sessions.filter((session) => session.memoryTokens > 0);
  if (sessionsWithMemory.length > 0) {
    const tokens = sessionsWithMemory.reduce((total, session) => total + session.memoryTokens, 0) / sessionsWithMemory.length;
    row('Memory loaded at start', `${formatInteger(tokens)} tokens, rent ${formatInteger(summary.memoryCostPerSession)} per session`);
    row('Memory share of cost', formatPercent(summary.memoryShare));
  }
  const { lines } = report;
  const unknown = Object.entries(lines.unknownTypes);
  const invalid = Object.entries(lines.invalid);
  const skippedCount = lines.malformed + lines.orphanResults + [...unknown, ...invalid].reduce((total, [, n]) => total + n, 0);
  if (skippedCount > 0) {
    const reasons = [
      lines.malformed > 0 ? `${lines.malformed} malformed` : '',
      ...unknown.map(([type, n]) => `${n} of unknown type "${type}"`),
      ...invalid.map(([type, n]) => `${n} "${type}" with missing fields`),
      lines.orphanResults > 0 ? `${lines.orphanResults} tool results with no call` : '',
    ].filter(Boolean);
    row('Lines skipped', `${formatInteger(skippedCount)} of ${formatInteger(lines.total)}: ${reasons.join(', ')}`);
  }
  for (const note of report.approximations) out.push(`  ${c.yellow('≈')} ${note}`);
  if (window.sessions === 0) out.push(`  ${c.dim('No sessions to measure in this folder.')}`);
  out.push('');

  // 2. Top rediscoveries
  out.push(c.bold('Top rediscoveries'));
  if (report.rediscoveries.length === 0) {
    out.push(`  ${c.dim('No context was read again from an earlier session.')}`);
  } else {
    out.push(c.dim(`  ${'#'.padStart(2)}  ${'What'.padEnd(48)}${'Times'.padStart(6)}${'Tokens'.padStart(10)}${'Cost'.padStart(10)}`));
    report.rediscoveries.slice(0, TOP_REDISCOVERIES).forEach((item, index) => {
      out.push(`  ${String(index + 1).padStart(2)}  ${truncate(rediscoveryLabel(item), 48).padEnd(48)}${String(item.count).padStart(6)}${formatInteger(item.tokens).padStart(10)}${formatInteger(item.cost).padStart(10)}`);
    });
    const more = report.rediscoveries.length - TOP_REDISCOVERIES;
    if (more > 0) out.push(`  ${c.dim(`… ${more} more with --json`)}`);
  }
  out.push('');

  // 3. Memory lines never used
  out.push(c.bold(`Memory lines never used in the last ${window.sessions === 1 ? 'session' : `${window.sessions} sessions`}`));
  const { unusedLines, unverifiableLines, usedLines, files } = report.memory;
  if (files.length === 0) {
    out.push(`  ${c.dim('No memory files were loaded.')}`);
  } else if (unusedLines.length === 0) {
    out.push(`  ${c.dim(`All ${usedLines} lines with something to check were used.`)}`);
  } else {
    const maxLines = options.maxLines ?? 50;
    for (const line of unusedLines.slice(0, maxLines)) {
      out.push(`  ${c.cyan(`${short(line.file)}:${line.line}`)}  ${truncate(line.text, 100)}`);
    }
    if (unusedLines.length > maxLines) out.push(`  ${c.dim(`… ${unusedLines.length - maxLines} more with --json`)}`);
  }
  if (unverifiableLines.length > 0) {
    const one = unverifiableLines.length === 1;
    out.push(`  ${c.dim(`${unverifiableLines.length} ${one ? 'line has' : 'lines have'} nothing to check, such as a rule of style. ${one ? 'It is' : 'They are'} listed with --json.`)}`);
  }
  out.push('');

  // 4. Where the cost goes
  out.push(c.bold('Where the cost goes'));
  const { breakdown } = report;
  if (breakdown.groups.length === 0) {
    out.push(`  ${c.dim('No cost to break down.')}`);
    return `${out.join('\n')}\n`;
  }
  out.push(c.dim(`  ${'What'.padEnd(48)}${'Tokens'.padStart(12)}${'Cost'.padStart(14)}${'Share'.padStart(8)}`));
  const shown = breakdown.groups.filter((group) => group.share >= MIN_GROUP_SHARE);
  for (const group of shown) {
    const label = group.group === 'rebuild' ? `${group.label} (${breakdown.cacheRebuilds} times)` : group.label;
    const tokens = group.tokens > 0 ? formatInteger(group.tokens) : '';
    out.push(`  ${truncate(label, 48).padEnd(48)}${tokens.padStart(12)}${formatInteger(group.cost).padStart(14)}${formatPercent(group.share).padStart(8)}`);
  }
  const hidden = breakdown.groups.length - shown.length;
  if (hidden > 0) out.push(`  ${c.dim(`… ${hidden} more under ${formatPercent(MIN_GROUP_SHARE)} each, with --json`)}`);
  out.push(`  ${c.dim(`Known blocks explain ${formatPercent(breakdown.explained)} of the cost; the rest is context the transcript does not record.`)}`);

  if (breakdown.topBlocks.length > 0) {
    out.push('');
    out.push(c.dim(`  ${'#'.padStart(2)}  ${'Most costly blocks'.padEnd(46)}${'Tokens'.padStart(10)}${'Turn'.padStart(7)}${'Kept'.padStart(7)}${'Cost'.padStart(13)}`));
    breakdown.topBlocks.forEach((block, index) => {
      out.push(`  ${String(index + 1).padStart(2)}  ${truncate(block.label, 46).padEnd(46)}${formatInteger(block.tokens).padStart(10)}${formatInteger(block.turn).padStart(7)}${formatInteger(block.turnsKept).padStart(7)}${formatInteger(block.cost).padStart(13)}`);
    });
    out.push(`  ${c.dim('Turn: the API call where the block entered the context. Kept: the calls that read it again.')}`);
  }
  return `${out.join('\n')}\n`;
}

/** Groups below this share of the cost are left to the JSON report. */
const MIN_GROUP_SHARE = 0.01;
