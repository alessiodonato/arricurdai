// Prints one JSON line of metrics for one variant of the context experiment.
//   node metrics.mjs <repo> <workdir> <variant> <acceptance-exit> <tests-exit>
// Only the sessions of the last run count: their ids come from the results that run.sh saved in <workdir>/out.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const [repo, work, variant, acceptanceExit, testsExit] = process.argv.slice(2);
const { DEFAULT_COST_PARAMS, profile } = await import(join(repo, 'packages/core/dist/index.js'));
const { findTranscriptsDir, parseProject } = await import(join(repo, 'packages/transcripts/dist/index.js'));

const out = join(work, 'out');
const root = realpathSync(join(work, variant));

// What `claude -p` printed for each step. `total_cost_usd` is the running total of the session, so the
// cost of a session is its largest value.
const results = readdirSync(out)
  .filter((name) => name.startsWith(`${variant}-`) && name.endsWith('.json'))
  .map((name) => ({ step: name.slice(variant.length + 1, -'.json'.length), ...JSON.parse(readFileSync(join(out, name), 'utf8')) }));
const usdBySession = new Map();
for (const result of results) {
  usdBySession.set(result.session_id, Math.max(usdBySession.get(result.session_id) ?? 0, result.total_cost_usd ?? 0));
}
const usd = [...usdBySession.values()].reduce((total, value) => total + value, 0);
const failed = results.filter((result) => result.is_error).map((result) => `${result.step}: ${result.api_error ?? result.subtype}`);

const found = await findTranscriptsDir(root);
if (!found) {
  console.log(JSON.stringify({ variant, error: 'no transcripts' }));
  process.exit(0);
}
const project = await parseProject(found.dir);
const sessions = project.sessions.filter((session) => usdBySession.has(session.sessionId));
const report = profile({ ...project, sessions }, { projectRoot: root, generatedAt: new Date().toISOString(), sessions: 100 });

const contexts = sessions.flatMap((session) => [session.main, ...session.subagents]);
const size = ({ usage }) => usage.input + usage.cacheWrite + usage.cacheRead;
const mainCalls = sessions
  .flatMap((session) => session.main.calls)
  .filter((call) => call.timestamp !== undefined)
  .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

// A break of more than an hour before a step: its first call writes again the prefix it read from the cache.
const starts = new Map();
for (const line of readFileSync(join(out, 'run.log'), 'utf8').split('\n')) {
  const match = /^\[(\S+)\] (\S+): start (s\d)$/.exec(line);
  if (match && match[2] === variant) starts.set(match[3], Date.parse(match[1]));
}
const prefixes = [];
for (const step of ['s2', 's3', 's4', 's5']) {
  const first = mainCalls.find((call) => Date.parse(call.timestamp) >= (starts.get(step) ?? Infinity));
  if (first) prefixes.push(first.usage.cacheRead);
}
const breakCost = prefixes.reduce((total, prefix) => total + (DEFAULT_COST_PARAMS.w1h - DEFAULT_COST_PARAMS.r) * prefix, 0);

// A file read again with the same content, in any context of the variant: after a compaction or in a
// new session the agent has to, within one context it did not need to.
const seen = new Set();
let rereads = 0;
let rereadTokens = 0;
const reads = contexts
  .flatMap((context) => context.reads)
  .filter((read) => read.kind === 'file' && !read.isError)
  .sort((a, b) => Date.parse(a.timestamp ?? 0) - Date.parse(b.timestamp ?? 0));
for (const read of reads) {
  const id = `${read.key}\n${read.resultHash}`;
  if (seen.has(id)) {
    rereads++;
    rereadTokens += read.tokens;
  }
  seen.add(id);
}

console.log(JSON.stringify({
  variant,
  acceptance: acceptanceExit === '0',
  tests: testsExit === '0',
  failed,
  sessions: sessions.length,
  calls: contexts.reduce((total, context) => total + context.calls.length, 0),
  meanContext: mainCalls.length === 0 ? 0 : mainCalls.reduce((total, call) => total + size(call), 0) / mainCalls.length,
  maxContext: Math.max(0, ...mainCalls.map(size)),
  stepPrefixes: prefixes,
  compactions: contexts.reduce((total, context) => total + context.compactions.length, 0),
  usd,
  cost: report.summary.totalCost,
  breakCost,
  rereads,
  rereadTokens,
  rediscoveries: report.rediscoveries.reduce((total, item) => total + item.count, 0),
}));
