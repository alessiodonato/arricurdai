#!/bin/bash
# Runs the context experiment: the same five steps of work on go-chi/chi under four variants.
#
#   experiments/context/run.sh <workdir> [variant...]
#
# Variants: baseline (one session), cap (auto-compact window of 100,000 tokens), compact (/compact
# between steps), handoff (a new session per step, with a note left by the previous one).
# <workdir>/base must be a clone of https://github.com/go-chi/chi; each variant works on a copy.
# Go runs offline: no module proxy and no toolchain download.
set -u

WORK="$(cd "$1" && pwd -P)"
shift
VARIANTS="${*:-baseline cap compact handoff}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$WORK/out"
mkdir -p "$OUT"

# Started from inside a Claude Code session, the sessions this script starts must not inherit its variables.
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN \
  CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_EXECPATH

ALLOW='"Read","Grep","Glob","Edit","Write","Agent","Task","Bash(ls)","Bash(ls *)","Bash(cat *)","Bash(head *)","Bash(tail *)","Bash(grep *)","Bash(rg *)","Bash(find *)","Bash(sed -n *)","Bash(wc *)","Bash(cd *)","Bash(pwd)","Bash(git log *)","Bash(git diff)","Bash(git diff *)","Bash(git status)","Bash(git show *)","Bash(go test *)","Bash(go vet *)","Bash(go build *)","Bash(go doc *)","Bash(go list *)","Bash(gofmt *)"'
SETTINGS="{\"permissions\":{\"allow\":[$ALLOW],\"deny\":[\"WebFetch\",\"WebSearch\"]}}"

log() { echo "[$(date -u +%FT%TZ)] $1: $2" | tee -a "$OUT/run.log"; }

# step <variant> <label> <--session-id|--resume> <id> <prompt> [extra claude options...]
# Fails when the API refused the request, for example because the usage limit was reached:
# the steps after it would run on a half-done step.
step() {
  local variant="$1" label="$2" flag="$3" id="$4" prompt="$5" status
  shift 5
  log "$variant" "start $label"
  (cd "$WORK/$variant" && env GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=mod \
    claude -p "$prompt" "$flag" "$id" --model sonnet --output-format json \
      --strict-mcp-config --setting-sources project,local --settings "$SETTINGS" \
      --permission-mode acceptEdits --permission-prompts none --max-budget-usd 3 "$@" \
      < /dev/null > "$OUT/$variant-$label.json" 2>> "$OUT/$variant.err")
  status=$?
  log "$variant" "end $label, exit $status"
  if grep -q '"api_error":' "$OUT/$variant-$label.json"; then
    log "$variant" "stopped: the API refused $label"
    return 1
  fi
}

prompt() { cat "$HERE/prompts/s$1.txt"; }
new_id() { uuidgen | tr 'A-Z' 'a-z'; }

run_variant() {
  local variant="$1" id
  rm -rf "${WORK:?}/$variant" && cp -R "$WORK/base" "$WORK/$variant"
  rm -f "$OUT/$variant"-*.json "$OUT/$variant.err"
  case "$variant" in
    baseline|cap)
      local extra=()
      [ "$variant" = cap ] && extra=(--autocompact 100000)
      id="$(new_id)"
      step "$variant" s1 --session-id "$id" "$(prompt 1)" ${extra[@]+"${extra[@]}"} || return 1
      for n in 2 3 4 5; do
        step "$variant" "s$n" --resume "$id" "$(prompt "$n")" ${extra[@]+"${extra[@]}"} || return 1
      done
      ;;
    compact)
      id="$(new_id)"
      step "$variant" s1 --session-id "$id" "$(prompt 1)" || return 1
      for n in 2 3 4 5; do
        step "$variant" "c$n" --resume "$id" "/compact" || return 1
        step "$variant" "s$n" --resume "$id" "$(prompt "$n")" || return 1
      done
      ;;
    handoff)
      for n in 1 2 3 4 5; do
        local body
        body="$(prompt "$n" | sed 's/Do not modify any files\./Do not modify any file except HANDOFF.md./')"
        step "$variant" "s$n" --session-id "$(new_id)" "Start by reading HANDOFF.md, the note the previous session left, if it exists.

$body

Before you finish, rewrite HANDOFF.md as a note of at most 30 lines for the next session: what is done, the files involved, decisions, and what is left." || return 1
      done
      ;;
    *) log "$variant" "unknown variant"; return 1 ;;
  esac
  log "$variant" "done"
}

for variant in $VARIANTS; do run_variant "$variant" & done
wait
log all "finished"
