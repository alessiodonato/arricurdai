# Claude Code transcript schema

This page covers what `arricurdai profile` reads from Claude Code transcripts, where it finds it, and the rules the parser follows. Anthropic does not document this format. Everything here was observed directly, and the parser treats transcripts as untrusted input that can change between versions.

## How it was observed

- **Claude Code 2.1.310, headless (`claude -p`).** Five sessions on the public repository [`vitejs/vite`](https://github.com/vitejs/vite) at commit `e954a9c`, written for this purpose:
  - `/init`;
  - an exploration of hot module replacement (HMR);
  - two changes, one of them with two resumes and a `/compact`;
  - an Explore subagent.
- **Claude Code 2.1.310 on a throwaway project with marker files.** This showed which memory files are loaded and how they are recorded, and forced a tool output large enough to be saved to disk.
- **Claude Code 2.1.301, interactive.** One session, read for structure only: field names, value types and counts, never content.
- **Cross-check with `cost-state`.** The deduplicated `usage` totals match the `cost-state` totals that Claude Code writes in the same files. The one gap is compaction (see [Usage](#usage)).

No real transcript is copied into this repository. The fixtures in `fixtures/` are synthetic.

## Files on disk

```
~/.claude/projects/<project>/                   $CLAUDE_CONFIG_DIR/projects/... when that variable is set
  <sessionId>.jsonl                             one session, one JSON object per line
  <sessionId>/subagents/agent-<agentId>.jsonl   one file per subagent
  <sessionId>/subagents/agent-<agentId>.meta.json
  <sessionId>/tool-results/<id>.txt             full output of a tool result too large for the context
  memory/MEMORY.md                              auto memory index
  memory/<topic>.md                             auto memory topic files
```

- `<project>` is the absolute project path with every `/` replaced by `-`, so `/Users/me/code/shop` becomes `-Users-me-code-shop`. The mapping cannot be reversed, because a `-` in the path stays `-`. The profiler also matches the `cwd` field of the lines.
- `--resume` appends to the same file and keeps the same `sessionId`.
- Claude Code deletes transcripts after `cleanupPeriodDays`, which defaults to 30 days. Older sessions cannot be profiled.

## Line types

Every line is a JSON object with a `type`.

### Conversation lines

These lines form a chain through `uuid` and `parentUuid`. Each one carries:

- `sessionId`;
- `timestamp` (ISO 8601, UTC);
- `cwd` and `gitBranch`;
- `version`;
- `entrypoint`: `cli` when interactive, `sdk-cli` when headless;
- `isSidechain`.

| `type` | Holds |
| --- | --- |
| `user` | One of four things. A **prompt**, when `message.content` is a string. **Tool results**, when `message.content` is an array of `tool_result` blocks; the line also has `toolUseResult`. A **meta line**, marked `isMeta: true`. A **compaction summary**, marked `isCompactSummary: true`. |
| `assistant` | One content block (`thinking`, `text` or `tool_use`) of one API response. A response with three blocks takes three lines with the same `message.id` and the same `usage`. |
| `attachment` | Context that Claude Code injects, such as memory files, the environment, the date and reminders. `attachment.type` names the kind. `rendered[].content` is the text actually sent, wrapped in `<system-reminder>`. |
| `system` | Events. `subtype: "compact_boundary"` marks a compaction. `subtype: "turn_duration"` closes an interactive turn. |

### Metadata lines

These lines are not part of the chain, and most carry only `sessionId`.

| `type` | Holds |
| --- | --- |
| `queue-operation` | `enqueue` / `dequeue` of a prompt: the headless prompt, or a message typed while the agent is working. |
| `api-request` | One line per API request: model, parameters and cache TTLs. The request itself is stored as a delta, `base` plus `tail` (a list of blob hashes). |
| `api-request-blob` | The message blobs, addressed by hash, that `api-request` points to. Tool results appear only as `[tool_result]` placeholders. |
| `api-request-shape` | System prompt blocks and tool definitions, written whenever they change. |
| `cost-state` | Running totals per model, in tokens and in USD. These totals include subagents and compaction. |
| `file-history-snapshot`, `file-history-delta` | Backups of the files edited in the session. |
| `last-prompt`, `ai-title`, `mode`, `permission-mode`, `atis-latch` | Interface state. |

The profiler uses `user`, `assistant`, `attachment`, `system` and `cost-state`. It ignores the other types listed here, and counts and skips any type it does not recognize.

## Where each piece is

### Messages

- **User prompt:** `type: "user"` with a string `message.content`. When `origin` is present, it is `{kind: "human"}`. Lines with `isMeta` or `isCompactSummary` are not prompts.
- **Notifications:** `type: "user"` with `origin.kind: "task-notification"` and text that starts with `<task-notification>`. These lines are not prompts. They carry, for example, the report of an async subagent back to the parent.
- **Assistant text:** blocks `{type: "text", text}` and `{type: "thinking", thinking, signature}` in `message.content[]`.

### Tool calls

A tool call is a block `{type: "tool_use", id, name, input}` in an `assistant` line.

The tool set changes between versions. The table lists what the observed sessions offered and used. **In 2.1.310 there is no `Grep` or `Glob`:** searches go through `Bash`.

| `name` | `input` |
| --- | --- |
| `Read` | `file_path` (absolute), `offset`, `limit`. The result has line numbers. |
| `Bash` | `command`, optional `description`, `timeout`, `run_in_background`. Commands often start with `cd <dir> &&` and then use relative paths. |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `Write` | `file_path`, `content` |
| `Agent` | `description`, `prompt`, `subagent_type` |
| `Grep`, `Glob` | Not observed. Earlier versions had `Grep` (`pattern`, `path`, `glob`, `output_mode`, …) and `Glob` (`pattern`, `path`). The parser still accepts them. |

`wireIngestContext[<tool_use id>].cwd` on the `assistant` line, when present, is the working directory for that call. Otherwise the line's `cwd` applies. The working directory can change during a session; an `environment` attachment records each change.

### Tool results

A tool result is a block `{type: "tool_result", tool_use_id, content, is_error?}` in a `user` line. `content` is either a string or an array of `{type: "text", text}` blocks.

**`content` is what enters the model's context, so the profiler measures its size.**

The same line carries `toolUseResult`, a structured copy for the interface. It can be much larger than what the model saw: an `Edit` keeps the whole original file in `originalFile`, and a `Bash` keeps up to 30,000 characters of `stdout`. The profiler never uses it for sizes.

| Tool | `toolUseResult` |
| --- | --- |
| `Read` | `{type: "text", file: {filePath, content, startLine, numLines, totalLines}}` |
| `Bash` | `{stdout, stderr, interrupted, isImage, noOutputExpected}`, plus `persistedOutputPath` and `persistedOutputSize` when the output was saved to disk |
| `Edit` | `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}` |
| `Write` | `{type: "create", filePath, content, structuredPatch, originalFile}` |
| `Agent` (async) | `{isAsync, status: "async_launched", agentId, outputFile, …}` |
| denied call | a string that starts with `Error: Permission …`, and `is_error: true` on the block |

**Large outputs.** When a result is too large, Claude Code saves the full output to `<sessionId>/tool-results/<id>.txt`. The context gets only a preview of about 2 KB:

```
<persisted-output>
Output too large (293KB). Full output saved to: <absolute path>/tool-results/b67pzo2su.txt

Preview (first 2KB):
...
</persisted-output>
```

The model saw only the preview, so the preview is the size that counts. If the agent then reads the saved file, that read is a separate context read.

### Usage

Usage is in `message.usage` on `assistant` lines:

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 5741,
  "cache_read_input_tokens": 8380,
  "output_tokens": 509,
  "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 5741 },
  "output_tokens_details": { "thinking_tokens": 0 },
  "iterations": [ { "input_tokens": 2, "cache_creation_input_tokens": 5741, "...": "..." } ],
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard"
}
```

- **Repeated usage.** `usage` repeats on every line of the same `message.id`. One response took 13 lines in the lab sessions. **Summing lines instead of distinct ids overcounts by 2 to 3 times.**
- **Cache write split.** `cache_creation_input_tokens` equals `ephemeral_5m_input_tokens` plus `ephemeral_1h_input_tokens`.
  - Main sessions wrote to the 1-hour cache.
  - The Explore subagent wrote to the 5-minute cache.
  - The two cost different amounts: 2× and 1.25× the input price.
- **Iterations.** `iterations[]` breaks one response into parts. The top-level fields are the total.
- **Compaction.** The compaction call writes no `assistant` line. Its usage shows up only in `cost-state`, as the difference between those totals and the sum of the `assistant` lines. In the lab session it was 2,096 input, 278 cache-write, 17,278 cache-read and 1,734 output tokens.
- **Subagents.** A subagent's usage is only in its own file. The parent's `cost-state` includes it.

### Timestamps and session

`timestamp` is on every conversation line and on `queue-operation`. `sessionId` is on every line.

A subagent file has the parent's `sessionId`, plus `agentId` and `isSidechain: true` on every line. Its `.meta.json` contains `{agentType, description, toolUseId, spawnDepth, …}`, and `toolUseId` links it to the parent's `Agent` call.

### Memory files

Memory is recorded in `attachment` lines. The profiler does not have to rebuild it from disk.

- **At the start of a session:** `attachment.type: "instructions"`, with `files[]` set to `{path, type, content}` and `rendered[0].content` holding the exact text sent.
- **On demand:** `attachment.type: "nested_memory"`, written right after the tool call that read a file in a folder with its own `CLAUDE.md`. Its fields are `{path, displayPath, content: {path, type, content}}`.

Claude Code 2.1.310 loaded the following on a test project, one marker per file:

| File | Loaded at start | Recorded as |
| --- | --- | --- |
| `CLAUDE.md` in a parent folder | yes | `instructions`, `type: "Project"` |
| `CLAUDE.md` in the project root | yes | `Project` |
| file imported with `@path` | yes, as its own entry | `Project` |
| `.claude/CLAUDE.md` | yes | `Project` |
| `.claude/rules/*.md` | yes | `Project` |
| `CLAUDE.local.md` | yes | `type: "Local"` |
| `memory/MEMORY.md` | first 200 lines, followed by a warning that names the cut lines | `type: "AutoMem"` |
| `memory/<topic>.md` | no | — |
| `CLAUDE.md` in a subfolder | no, only on the first read in that folder | `nested_memory` |
| `~/.claude/CLAUDE.md` | not tested, because this machine has none | expected `type: "User"` |

In headless mode, `Project` files load only when `--setting-sources` includes `project`.

### Compaction

1. A line `{type: "system", subtype: "compact_boundary", parentUuid: null, logicalParentUuid, compactMetadata: {trigger: "manual" | "auto", preTokens, postTokens, …}}` closes the old context.
2. A `user` line with `isCompactSummary: true` then holds the summary that opens the new one.

## Parser rules

1. **One API call per distinct `message.id`.** Its `usage` is counted once.
2. **Turn order.** The turns of a context are its API calls in the order they first appear. `T` is the number of calls in that context. The main session and each subagent are separate contexts.
3. **When a result enters the context.** A tool result enters at the first API call after its line, and that call's index is `t`.
4. **Size of a result.** It is the estimated tokens of the `tool_result` `content`, joining text blocks when there is an array. For a saved output, only the preview counts.
5. **Cache writes.** They are priced as `w·ephemeral_5m + w1h·ephemeral_1h`. When the split is missing, the price is `w·cache_creation_input_tokens`.
6. **Compaction.** A `compact_boundary` closes the context. Blocks that entered before it stop paying rent at the boundary. The compaction call's cost comes from `cost-state`.
7. **Subagents.** Their usage is added to the parent session. Their reads are context reads within their own context. In the parent, only the subagent's report counts, as a tool result.
8. **Paths.** A target path is resolved in this order, then made relative to the project root:
   1. the `cd` at the start of a Bash command;
   2. `wireIngestContext[id].cwd`;
   3. the line's `cwd`.
9. **Memory.** Memory comes from `instructions` (loaded at turn 1) and `nested_memory` (with its own position). The profiler rebuilds memory from disk only when a session has no `instructions` attachment, as in older versions, and then marks the measure as approximate.
10. **Bad and unknown lines.** Malformed lines, lines that are not objects and unknown types are counted per category and skipped.

## Open points

- Only versions 2.1.301 and 2.1.310 were observed. Older transcripts may have no `instructions`, `api-request` or `cost-state` lines. The parser must work without them and say so.
- User-level `~/.claude/CLAUDE.md` and managed policy files were not observed.
- Neither `trigger: "auto"` compactions nor `--fork-session` were observed.
