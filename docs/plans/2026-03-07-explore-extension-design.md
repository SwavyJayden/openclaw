# Explore Extension Design

## Summary

An openclaw extension that registers an `explore` tool for the main agent. When called, it spawns a stateless Haiku sub-agent with read-only codebase tools to search and summarize findings. This gives the main agent cheap, fast codebase exploration without consuming expensive Opus tokens on grep/read cycles.

## Tool Interface

```
Tool: explore
Parameters:
  - query (string, required): What to explore. E.g., "how does auth token refresh work"
  - scope (string, optional): Directory to scope the search to. Defaults to workspace root.

Returns: text summary — files examined, key findings, relevant code snippets.
```

## Sub-agent Configuration

- **Model**: `claude-haiku-4-5-20251001` (hardcoded)
- **Provider**: `anthropic`
- **Tools**:
  - `read` — read files and list directories
  - `exec` — shell commands, allowlisted to: `grep`, `rg`, `find`, `ls`, `wc`, `head`, `tail`
- **Timeout**: 60 seconds
- **Session**: stateless — fresh temp directory per call, cleaned up after
- **System prompt**: instructs the sub-agent to search the codebase, be concise, and return structured findings

## Architecture

```
Main Agent (Opus)
  │
  ├─ calls explore(query, scope?)
  │
  ▼
Explore Extension (tool handler)
  │
  ├─ creates temp session dir
  ├─ builds system prompt + user query
  ├─ calls runEmbeddedPiAgent() with:
  │   - model: haiku
  │   - tools: read + sandboxed exec
  │   - timeout: 60s
  │
  ▼
Haiku Sub-agent
  │
  ├─ greps/finds relevant files
  ├─ reads file contents
  ├─ synthesizes findings
  │
  ▼
Text summary returned to main agent
```

## File Structure

```
extensions/explore/
  index.ts              — plugin entry, registers tool via api.registerTool()
  src/
    explore-tool.ts     — tool definition + sub-agent orchestration
    prompts.ts          — system prompt for the explorer sub-agent
  package.json          — peerDependencies: openclaw
  openclaw.plugin.json  — plugin metadata
```

## Design Decisions

1. **Hardcoded Haiku** — simplicity over configurability. Can add model config later if needed.
2. **Stateless** — each call starts fresh. The main agent already has conversation context and can pass relevant info in the query.
3. **Read-only tools** — `read` + allowlisted `exec`. No write, edit, or arbitrary shell. Safe to run without approval.
4. **Plugin tool pattern** — follows existing `diffs` and `llm-task` extension conventions. Uses `runEmbeddedPiAgent()` directly for full control over model and tool restrictions.
5. **60s timeout** — generous enough for multi-file exploration, short enough to not block the main agent.

## Exec Allowlist

The `exec` tool is restricted to read-only commands:

- `grep` / `rg` — content search
- `find` — file discovery
- `ls` — directory listing
- `wc` — line/word counts
- `head` / `tail` — partial file reads

Any command not starting with one of these is rejected by the tool handler.

## References

- `extensions/memory-loop/` — plugin structure reference
- `extensions/llm-task/` — `runEmbeddedPiAgent()` usage reference
- `extensions/diffs/` — tool registration reference
- `src/agents/pi-embedded-runner/run.ts` — embedded agent runner
- `src/plugins/types.ts` — `OpenClawPluginApi` interface
