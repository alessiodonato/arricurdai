#!/bin/bash
# Checks the result of each variant with the hidden acceptance tests, then measures its sessions.
#
#   experiments/context/evaluate.sh <workdir> [variant...]
#
# Needs `pnpm build` in the repository first, for the profiler.
set -u

WORK="$(cd "$1" && pwd -P)"
shift
VARIANTS="${*:-baseline cap compact handoff}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RESULTS="$WORK/out/results.jsonl"
: > "$RESULTS"

for variant in $VARIANTS; do
  dir="$WORK/$variant"
  [ -d "$dir" ] || { echo "$variant: missing"; continue; }
  cp "$HERE/acceptance/accept_list_routes_test.go" "$dir/"
  cp "$HERE/acceptance/middleware/accept_method_allow_list_test.go" "$dir/middleware/"
  (cd "$dir" && env GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=mod go test -count=1 -run 'TestArricurdaiAcceptance' ./... > "$WORK/out/$variant-acceptance.txt" 2>&1)
  acceptance=$?
  (cd "$dir" && env GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=mod go test -count=1 ./... > "$WORK/out/$variant-tests.txt" 2>&1)
  tests=$?
  rm -f "$dir/accept_list_routes_test.go" "$dir/middleware/accept_method_allow_list_test.go"
  node "$HERE/metrics.mjs" "$REPO" "$WORK" "$variant" "$acceptance" "$tests" >> "$RESULTS"
done

node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const n = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x, base) => (base ? `${(((x - base) / base) * 100).toFixed(1)}%` : "");
const row = (cells) => console.log(`| ${cells.join(" | ")} |`);
const base = rows.find((r) => r.variant === "baseline" && !r.error);
const header = ["variant", "acceptance", "all tests", "failed steps", "sessions", "calls", "mean context", "max context", "compactions", "USD", "cost K", "vs baseline", "K with breaks", "vs baseline", "re-reads (tokens)"];
row(header);
row(header.map(() => "---"));
for (const r of rows) {
  if (r.error) { row([r.variant, r.error]); continue; }
  const withBreaks = r.cost + r.breakCost;
  row([r.variant, r.acceptance ? "pass" : "FAIL", r.tests ? "pass" : "FAIL", r.failed.join(", ") || "none", r.sessions, r.calls,
    n(r.meanContext), n(r.maxContext), r.compactions, r.usd.toFixed(2), n(r.cost), pct(r.cost, base?.cost),
    n(withBreaks), pct(withBreaks, base && base.cost + base.breakCost), `${r.rereads} (${n(r.rereadTokens)})`]);
}' "$RESULTS"
