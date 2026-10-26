# Context experiment

**Question.** In a long session, which way of keeping the context small saves the most tokens without hurting the work?

Profiles of long interactive sessions show that most of the cost comes from reading a large context again on every call, and from writing it again after a pause. Replays put the saving of smaller contexts at 30% to 68%. They count neither the files the agent reads again after a compaction nor any loss of quality, so this experiment measures both.

## Setup

- **Repository.** [`go-chi/chi`](https://github.com/go-chi/chi) at commit `9f8adb1`. It is a Go router with no dependencies, so its tests run offline.
- **Work.** One hour of work in five steps, in [`prompts/`](prompts):
  1. understand the routing;
  2. add a `MethodAllowList` middleware, with tests;
  3. add a `ListRoutes` function, with tests;
  4. change the middleware, with tests;
  5. document both and run `go vet`.
- **Variants:**

  | Variant | Context policy |
  | --- | --- |
  | `baseline` | One session, as people usually work. |
  | `cap` | One session with an auto-compact window of 100,000 tokens (`--autocompact 100000`, or the `autoCompactWindow` setting). |
  | `compact` | One session, with `/compact` between steps, as before a break. |
  | `handoff` | A new session for each step. Each session reads `HANDOFF.md` and rewrites it for the next one. |

- **Claude Code settings.** Claude Code in headless mode with Sonnet, the project's settings only and no MCP servers. Permissions: commands that only read, `go test`, `go vet`, `go build`, `gofmt`, and file edits. No web. A spending cap of 3 USD per invocation.
- **Go.** It runs offline, with `GOPROXY=off` and `GOTOOLCHAIN=local`.
- **Success.** Hidden acceptance tests in [`acceptance/`](acceptance), copied into the clone only after the sessions, plus the whole test suite.
- **Measures.** From the profiler:
  - price-weighted cost;
  - API calls;
  - largest context;
  - compactions;
  - files read again within the same context, which a compaction can cause.

## Run

```sh
git clone --depth 1 https://github.com/go-chi/chi <workdir>/base
experiments/context/run.sh <workdir>        # the four variants, in parallel
pnpm build
experiments/context/evaluate.sh <workdir>   # acceptance tests, test suite, measures
```

## Results

First run on 26 October 2026, with Claude Code 2.1.310 and Sonnet 5.5. Every variant passed the acceptance tests and the whole test suite.

| Variant | Calls | Largest context | Compactions | Cost | vs baseline | With a pause before each step | vs baseline | Files read again |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `baseline` | 17 | 56,019 | 0 | $0.38 | | $1.07 | | 0 |
| `cap` | 15 | 54,559 | 0 | $0.37 | −4% | $1.02 | −4% | 0 |
| `compact` | 22 | 34,946 | 4 | $0.70 | +82% | $0.86 | −19% | 1 (1,019 tokens) |
| `handoff` | 29 | 37,175 | 0 | $0.48 | +25% | $0.64 | **−40%** | 2 (813 tokens) |

The cost is the one Claude Code reports. The two columns on pauses add, for each of steps 2 to 5, what its first call would pay to write the prefix it read from the cache again after more than an hour: (2 − 0.05) × the tokens it read, at the Sonnet 5.5 input price.

What the run shows:

- **Without pauses, compacting does not pay on contexts this small.** A compaction writes its summary at the output price, five times the input price.
- **After a pause longer than the cache lifetime, a new session with a short note costs least.** It does not write the old context to the cache again. The agent lost almost nothing: it read again two files, 813 tokens. [`arricurdai guard`](../../README.md#guard-no-cache-rewrite-after-a-pause) does this for you.
- **The cap never triggered.** The largest context stayed below 100,000 tokens, the smallest window Claude Code accepts. Long sessions need another run.

The prices come from the costs Claude Code records: for Sonnet 5.5 and Opus 5.5, a cache read costs 0.05 of an input token, a write to the 1-hour cache 2, an output token 5.

## Limits

- **One run per variant.** This is a pilot. Repeat it before trusting small differences.
- **No real pauses.** The steps run back to back. The columns on pauses are computed from the size of the context at each step.
- **The note.** In the `handoff` variant the agent writes the note itself. The note of `arricurdai handoff` is built from the transcript, without a model.
- **Only one model.** Each variant runs on Sonnet, and the results may differ with Opus.
