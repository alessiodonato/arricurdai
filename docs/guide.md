# Guide: profile your Claude Code project

This guide takes you from a fresh clone to a report you can act on. `arricurdai profile` only reads files on your machine: your project's Claude Code transcripts and its git history. Nothing is sent anywhere.

## 1. What you need

- Node 20 or later, and pnpm (`corepack enable` installs it).
- git, so the profiler can tell which files changed between sessions. It also works without git, less precisely.
- A project where you have used Claude Code. Its sessions are what gets measured.

## 2. Build it

arricurdAI is not on npm yet. Build it from this repository:

```sh
pnpm install
pnpm build
```

To call it as `arricurdai` from anywhere, add an alias to your shell profile (`~/.zshrc` or `~/.bashrc`):

```sh
alias arricurdai="node /path/to/arricurdai/packages/cli/dist/bin.js"
```

To check that it works, run it on the synthetic project in `fixtures/`. The output is in the [README](../README.md#example-output).

```sh
pnpm profile:fixtures
```

## 3. Profile your project

```sh
arricurdai profile --project ~/code/my-app
```

Without `--project` it profiles the current folder. It finds the transcripts that Claude Code keeps in `~/.claude/projects/` for that folder, reads every session, and measures the 20 most recent.

## 4. Read the report

The report has three parts.

### Summary

| Line | What it means |
| --- | --- |
| Sessions analyzed | How many sessions were measured, and the dates of the first and the last. |
| Mean cost K | The average cost of a session in price-weighted tokens. Every token counts at its own price, relative to an input token: cache writes 1.25× or 2×, cache reads 0.1×, output 5×. To get money, multiply by your model's price per input token. At 3 USD per million input tokens, a K of 55,728 is about 0.17 USD. |
| Read from cache | The share of input tokens served from the prompt cache. A high share is normal and cheap. |
| Rediscovery | The share of the tokens read as context (files, searches, listings) that the agent had already read in an earlier session, with nothing changed since. |
| S_max | What that rediscovery cost, as a share of all the spend. A memory that removes it would save at most this much. It is a ceiling, not a promise. |
| Memory loaded at start | The size of the CLAUDE.md files and MEMORY.md that Claude Code loads in every session, and the rent they pay over a session. |
| Memory share of cost | The share of all the spend that goes to memory files. |
| Lines skipped | Lines of the transcripts the parser could not use. They are counted and skipped. A few are harmless. |
| ≈ | What makes some numbers approximate, such as a project with no git history. |

### Top rediscoveries

These are the files, searches and listings the agent read again in later sessions, most costly first, with how many times and what that cost. A file that comes back in many sessions is worth a short note in memory: where it is, what it does, which function matters. A memory note costs rent too, so write one only for what keeps coming back.

### Memory lines never used

These are lines of your memory files whose terms (code spans, paths, file names, commands) never appeared in what the agent did, in any session that loaded them. For each one, choose:

- **Delete it**, if it is stale.
- **Move it** to a file that is loaded only when needed. For example, put rules about one folder in that folder's own CLAUDE.md, which Claude Code loads when the agent works there.
- **Keep it**, if it is rare but critical, such as a rule about releases.

Lines with nothing to check, such as "answer briefly", are counted apart. The profiler cannot tell whether a rule of style was followed.

### Where the cost goes

The last part splits the cost of the measured sessions among what made it up, with the ten most costly blocks. It is often the part with the most to act on:

| Line | What to do when it is large |
| --- | --- |
| Cache rebuilt after a pause | The cache keeps a context for about an hour. Coming back to a long session after a longer break writes the whole context again, at twice the input price. Before a long break, run `/compact`. Or start a new session afterwards, with a short note of where you were. |
| Assistant thinking | Thinking stays in the context of later calls. Use less thinking for routine work. |
| Tool results: Bash, MCP, Read | Large outputs stay in the context until the next compaction. Read ranges of files instead of whole files, and keep logs out of the conversation. Screenshots from browser tools cost about 1,500 tokens each. |
| Assistant replies and tool calls | Long replies are read again on every later call, like everything else. |
| System prompt, tools and skills; Text added by Claude Code | A fixed cost on every call. MCP servers and plugins you do not use make it larger. |
| Context carried over a compaction or a rewind | What `/compact` keeps, and the history before a rewind. |

"Known blocks explain …" says how much of the cost the breakdown can attribute. The rest is growth of the context that the transcript does not record.

### What if

In long sessions the report adds what compacting at other moments would have saved. The figures are ceilings: after a compaction the agent may read files again, which the replay does not count. If they are large:

- **Before a long break,** run `/compact`, or end the session with a short note and start a new one when you are back.
- **Keep contexts smaller** with a lower auto-compact window. Run `claude --help` and look for `--autocompact`.
- **Measure again** a couple of weeks later, and compare the two `--json` reports.

## 5. Options

| Option | Example | When to use it |
| --- | --- | --- |
| `--sessions <n>` | `--sessions 5` | To measure only the latest sessions, for example after you changed your CLAUDE.md. Older sessions still count as history. |
| `--json` | `--json > report.json` | To keep a report, compare two reports or script on it. |
| `--config <file>` | `--config prices.json` | To change the price weights (see below). |
| `--transcripts <dir>` | `--transcripts ~/.claude/projects/-Users-me-app` | When the profiler cannot find the transcripts by itself. |

Some ways to read the JSON with `jq`:

```sh
arricurdai profile --json | jq '.summary'
arricurdai profile --json | jq -r '.memory.unusedLines[] | "\(.file):\(.line)  \(.text)"'
arricurdai profile --json | jq '.sessions[] | {startedAt, cost, rediscoveryCost, cacheRebuilds}'
arricurdai profile --json | jq '.breakdown.groups[] | {label, share}'
```

The schema of the report is `reportSchema` in `@arricurdai/core`.

The price weights live in `arricurdai.config.json`, in the project or wherever `--config` points. Every field is optional:

```json
{ "w": 1.25, "w1h": 2, "r": 0.1, "mu": 5, "overhead": 300 }
```

## 6. Tips

- **Keep more history.** Claude Code deletes transcripts after 30 days. To measure further back, set a higher value in `~/.claude/settings.json`: `"cleanupPeriodDays": 365`.
- **Measure before and after.** Save `--json` reports before and after you prune or reorganize your memory, and compare `memoryCostPerSession` and `maxSavings`.
- **Look at the trend, not one session.** One long session can swing every number.

## 7. Troubleshooting

| Message | What to do |
| --- | --- |
| `no Claude Code transcripts found for …` | Use Claude Code in that folder at least once. If you started Claude Code from a different path, for example through a symbolic link, profile that path or pass `--transcripts`. If you set `CLAUDE_CONFIG_DIR`, the profiler uses it too. |
| `Project folder not found` | Check the path given to `--project`. |
| `--sessions must be a whole number of 1 or more` | Pass a number, such as `--sessions 10`. |
| `… Invalid arricurdai config. w: …` | Fix the field named in the message. Unknown fields are refused, so a typo does not go unnoticed. |
| `≈ The project has no git history …` | Rediscoveries are counted from the transcripts alone. Run `git init` and commit to make them precise for future sessions. |
| Many lines skipped | The transcript format may have changed in a newer Claude Code. Please open an issue with the counts in the report, but never attach a transcript: transcripts contain your code. |

To see where an unexpected error comes from, run the command again with `ARRICURDAI_DEBUG=1`.

## How the numbers are computed

The formulas, and what is approximate, are in the [README](../README.md#how-it-measures). What the parser reads in a transcript is in [transcript-schema.md](transcript-schema.md).
