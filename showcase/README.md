# Showcase

The baseline on public repositories in the main [README](../README.md#baseline-on-public-repositories) comes from these scripted sessions. They measure what Claude Code spends today on context it already knew. They do not measure savings: arricurdAI changes nothing in these sessions.

## Protocol

Each repository gets up to five Claude Code sessions on one area of its code, the way a developer comes back to the same part of a project over several days:

| Session | Task | Afterwards |
| --- | --- | --- |
| s0 | `/init`, only when the repository has no CLAUDE.md | commit |
| s1 | Explain how the area works. Read only. | |
| s2 | A small change in the area. | commit |
| s3 | Another small change in the same area. | commit |
| s4 | A question about the same area. Read only. | |

The prompts are in [`prompts/`](prompts). [`run.sh`](run.sh) runs them with Claude Code in headless mode, under these settings:

- **Model:** Sonnet.
- **Tools:** no MCP servers, and only the project's own settings, so CLAUDE.md is loaded but no user plugin is.
- **Permissions:**
  - the commands that only read, plus `git log`, `git diff`, `git show` and `git status`;
  - file edits in s2 and s3.

  No web tools. Dependencies are not installed, so the sessions run no tests and no builds.
- **Budget:** a spending cap on every session.
- **Safety:** the script stops if the clone contains `.claude/` or `.mcp.json`, so that it never runs a stranger's hooks or servers.

## Reproduce

```sh
showcase/run.sh vite https://github.com/vitejs/vite.git ~/arricurdai-showcase
node packages/cli/dist/bin.js profile --project ~/arricurdai-showcase/vite
```

The sessions use your Claude Code account. In our run each one cost between 0.05 and 0.23 USD, 1.42 USD for all fifteen.

## Limits

- **Small sample.** Five scripted sessions per repository are an example, not a statistic. Real projects have longer and messier histories, which the profiler measures the same way.
- **Warm cache.** The sessions run minutes apart, so each one starts with the system prompt still in the prompt cache. Sessions days apart pay to write it again, so the cost of these sessions is a little lower than usual. Rediscovery does not depend on this.
- **Only committed changes.** The changes between sessions are committed, as a developer would. `git log` and the edits in the transcripts tell the profiler which re-reads were of files that had changed.
