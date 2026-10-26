# Fixtures

All the data here is synthetic. Nothing is copied from a real transcript. The files imitate the format described in [`docs/transcript-schema.md`](../docs/transcript-schema.md).

The data comes from `generate.mjs`, which is deterministic. To change it, edit the script and run it again:

```sh
node fixtures/generate.mjs
```

## acme-shop

`acme-shop` is an invented TypeScript shop, worked on in three sessions on three different days. Its transcripts record `cwd: "/home/dev/acme-shop"`.

```
acme-shop/
  project/                              project root: memory files and sources
  claude-home/                          stands in for ~/.claude (CLAUDE_CONFIG_DIR)
    CLAUDE.md                           user memory
    projects/-home-dev-acme-shop/       transcripts of the project
      11111111-….jsonl                  session A
      22222222-….jsonl                  session B
      22222222-…/subagents/agent-a1b2c3d4e5f6a7b8c.jsonl (+ .meta.json)
      22222222-…/tool-results/k3x9q2m7p.txt
      33333333-….jsonl                  session C
      memory/MEMORY.md, memory/billing.md
```

### Sessions

The usage numbers below are summed once per `message.id`.

| Session | Date | Mode | API calls | Usage: in / cw 5m / cw 1h / cr / out | What it covers |
| --- | --- | --- | --- | --- | --- |
| A | 2026-09-01 | interactive (`cli`) | 7 | 9 / 0 / 16,800 / 87,300 / 1,240 | <ul><li>a response split over 3 lines</li><li>two `tool_use` in one response</li><li>reads via `Read`, `grep`, `cat`, `sed -n` and `find`</li><li>an `Edit`</li></ul> |
| B | 2026-09-02 | headless (`sdk-cli`) | 9, plus 3 in the subagent | 11 / 0 / 16,750 / 115,850 / 1,310, plus subagent 4 / 6,500 / 0 / 12,300 / 290 | <ul><li>re-reads</li><li>an async Explore subagent</li><li>an output saved to `tool-results/`</li><li>`pnpm test`</li></ul> |
| C | 2026-09-03 | interactive (`cli`) | 7 | 11 / 0 / 17,250 / 74,300 / 1,000 | <ul><li>`cd src && cat …`</li><li>a write redirect</li><li>`nested_memory`</li><li>`/compact`</li><li>broken lines</li></ul> |

`cost-state` is the cross-check:

- **A:** it equals the sum above.
- **B:** it equals the main session plus the subagent.
- **C:** it equals the sum plus the compaction call, which is 1,500 / 200 / 15,000 / 1,200 (in / cw / cr / out). The compaction call has no `assistant` line.

### Context reads

The key is (kind, target). The kind is `file`, `search` or `list`. The target is relative to the project root, or a search pattern with its folder. `t` is the API call where the result enters the context.

| Session | Call | Command | Key | Expected |
| --- | --- | --- | --- | --- |
| A | 1 | `Read src/checkout.ts` | file `src/checkout.ts` | first read, `t` = 2, `T` = 7 |
| A | 2 | `grep -rn "applyDiscount" src` | search `applyDiscount` in `src` | first read |
| A | 2 | `cat package.json` | file `package.json` | first read |
| A | 3 | `sed -n '1,40p' src/pricing.ts` | file `src/pricing.ts` | first read |
| A | 4 | `find src -name '*.test.ts'` | list `src` | first read |
| A | 5 | `Read src/cart.ts` | file `src/cart.ts` | first read; the file is edited in call 6 |
| B | 1 | `Read src/checkout.ts` | file `src/checkout.ts` | **rediscovery** (unchanged since A) |
| B | 2 | `Read src/pricing.ts` | file `src/pricing.ts` | **rediscovery**: same kind as the `sed -n` in A |
| B | 3 | `grep -rn "applyDiscount" src` | search `applyDiscount` in `src` | **rediscovery**: identical result |
| B | 4 | `Read src/cart.ts` | file `src/cart.ts` | not a rediscovery: edited in A |
| B | 6 | `cat logs/app.log` | file `logs/app.log` | first read; the size is the ~2 KB preview, not the 47 KB file |
| B, subagent | 1 | `Read src/db/orders.ts` | file `src/db/orders.ts` | first read, subagent context (`T` = 3) |
| B, subagent | 2 | `ls src/db` | list `src/db` | first read |
| C | 1 | `Read src/pricing.ts` | file `src/pricing.ts` | not a rediscovery: edited in B |
| C | 2 | `Read src/checkout.ts` | file `src/checkout.ts` | **rediscovery**; its rent stops at the compaction (after call 5) |
| C | 3 | `cat src/checkout.ts > /tmp/checkout-copy.ts` | — | not a read: it writes a file |
| C | 4 | `cd src && cat db/orders.ts` | file `src/db/orders.ts` | **rediscovery** of the subagent's read in B |
| C | 6 | `Read src/checkout.ts` | file `src/checkout.ts` | **rediscovery**, after the compaction |

These are not reads: `Edit` (A6, B7), `Agent` (B5) and `pnpm test` (B8).

No git commit happens between the sessions. Only the `Edit` calls in the transcripts mark files as changed.

### Memory

Every session loads the same `instructions`:

- the user `CLAUDE.md`;
- `CLAUDE.md`;
- `docs/conventions.md`, imported with `@`;
- `.claude/CLAUDE.md`;
- `.claude/rules/testing.md`;
- `CLAUDE.local.md`;
- `MEMORY.md`.

Session C also loads `src/db/CLAUDE.md` as `nested_memory`, after call 4. The topic file `memory/billing.md` is never loaded.

Expected use of each line over the three sessions. Headings and blank lines are ignored.

| File | Line | Expected |
| --- | --- | --- |
| `CLAUDE.md` | Run the tests with `pnpm test`. | used (B8) |
| `CLAUDE.md` | Prices and tax rules live in `src/pricing.ts` … | used |
| `CLAUDE.md` | Database access goes through `src/db/orders.ts`. | used |
| `CLAUDE.md` | Deploy with `scripts/deploy.sh --prod` … | **never used** |
| `CLAUDE.md` | The legacy `oldCheckout()` helper is deprecated … | **never used** |
| `CLAUDE.md` | Keep commit messages short and in the imperative mood. | not verifiable (no terms) |
| `CLAUDE.md` | See @docs/conventions.md for code style. | import, measured as its own file |
| `docs/conventions.md` | Validate request bodies with `zod` … | **never used** |
| `docs/conventions.md` | Money is stored in integer cents; see `toCents()` in `src/pricing.ts`. | used |
| `.claude/CLAUDE.md` | Never edit generated files under `src/generated/`. | **never used** |
| `.claude/rules/testing.md` | Tests sit next to the code as `*.test.ts` files. | used (A4) |
| `CLAUDE.local.md` | My local database listens on port 5433 (`docker compose up db`). | **never used** |
| `MEMORY.md` | … `computeTotals()` in `src/checkout.ts` | used |
| `MEMORY.md` | … `src/billing/webhook.ts` | **never used** |
| `src/db/CLAUDE.md` | Queries must use the `withTransaction()` wrapper from `src/db/tx.ts`. | **never used** |
| user `CLAUDE.md` | Answer in English, briefly. | not verifiable (no terms) |

### Broken lines (session C)

| Line | Expected category |
| --- | --- |
| `{"type":"assistant","message":{"id":"msg_fx_broken",…` (truncated) | malformed JSON |
| `[1,2,3]` | not an object |
| `"not an object"` | not an object |
| empty line | skipped |
| `{"type":"future-feature",…}` | unknown type |
| `{"type":"assistant",…,"content":"missing id and usage"}` | known type, invalid fields |
