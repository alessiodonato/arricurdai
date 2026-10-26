#!/bin/bash
# Runs the showcase sessions on one public repository with Claude Code in headless mode.
#
#   showcase/run.sh <name> <git-url> <workdir>
#
# <name> is a folder of prompts in showcase/prompts (s1.txt to s4.txt). The repository is cloned
# into <workdir>/<name>, and Claude Code writes the transcripts in its own folder for that path.
# Afterwards: arricurdai profile --project <workdir>/<name>
set -u

NAME="$1"
URL="$2"
WORK="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROMPTS="$HERE/prompts/$NAME"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
REPO="$WORK/$NAME"
LOG="$WORK/$NAME.log"

log() { echo "[$(date -u +%FT%TZ)] $NAME: $*" | tee -a "$LOG"; }

commit() {
  git -C "$REPO" add -A
  if git -C "$REPO" -c user.name=arricurdai-showcase -c user.email=showcase@example.invalid -c commit.gpgsign=false \
    commit -q -m "$1" 2>/dev/null; then
    log "commit: $1"
  else
    log "nothing to commit after: $1"
  fi
}

[ -d "$REPO" ] || git clone -q --depth 1 "$URL" "$REPO"
log "repository $URL at $(git -C "$REPO" rev-parse HEAD)"

# Never run a cloned repository's own hooks, settings or MCP servers without reading them first.
if [ -e "$REPO/.claude" ] || [ -e "$REPO/.mcp.json" ]; then
  log "the repository has .claude/ or .mcp.json: read them before running the sessions"
  exit 1
fi

ALLOW='"Read","Grep","Glob","Agent","Task","Bash(ls)","Bash(ls *)","Bash(cat *)","Bash(head *)","Bash(tail *)","Bash(grep *)","Bash(rg *)","Bash(find *)","Bash(sed -n *)","Bash(wc *)","Bash(cd *)","Bash(pwd)","Bash(git log)","Bash(git log *)","Bash(git show *)","Bash(git diff)","Bash(git diff *)","Bash(git status)","Bash(git status *)"'
READ_ONLY="{\"permissions\":{\"allow\":[$ALLOW],\"deny\":[\"WebFetch\",\"WebSearch\",\"Edit\",\"Write\",\"NotebookEdit\"]}}"
EDITS="{\"permissions\":{\"allow\":[$ALLOW],\"deny\":[\"WebFetch\",\"WebSearch\"]}}"

# session <label> <settings> <permission-mode> <budget in USD> <prompt>
session() {
  log "start $1"
  (cd "$REPO" && claude -p "$5" --model sonnet --output-format json \
    --strict-mcp-config --setting-sources project,local --settings "$2" \
    --permission-mode "$3" --permission-prompts none --max-budget-usd "$4" \
    < /dev/null > "$WORK/$NAME-$1.json" 2>> "$LOG")
  log "end $1, exit $?"
}

if [ ! -f "$REPO/CLAUDE.md" ]; then
  session s0-init "$EDITS" acceptEdits 2 "/init"
  commit "Add CLAUDE.md"
fi
session s1 "$READ_ONLY" default 3 "$(cat "$PROMPTS/s1.txt")"
session s2 "$EDITS" acceptEdits 2 "$(cat "$PROMPTS/s2.txt")"
commit "Showcase: first change"
session s3 "$EDITS" acceptEdits 2 "$(cat "$PROMPTS/s3.txt")"
commit "Showcase: second change"
session s4 "$READ_ONLY" default 2 "$(cat "$PROMPTS/s4.txt")"
log "done"
