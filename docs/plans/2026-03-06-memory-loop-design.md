# Memory Loop Extension Design

## Overview

Autonomous memory system for OpenClaw that observes sessions and extracts insights without being asked. Two components: an Observer that extracts facts/decisions/tasks every 20 inbound user messages, and a Reflector that produces a daily summary and distills long-term memory.

## Architecture

OpenClaw extension at `extensions/memory-loop/` with two components:

1. **Observer** — counts inbound user messages via `message:received` hook. Every 20th message, reads the last 20 messages from the session transcript, sends them to a cheap model (Haiku/Flash) to extract facts, decisions, tasks, preferences, and system changes. Appends to `memory/YYYY-MM-DD.md`.

2. **Reflector** — runs daily at midnight CT (6 AM UTC) via cron. Reads today's observations + current `MEMORY.md`, sends to cheap model to summarize the day, surface unfinished tasks, and spot patterns. Appends distilled section to `MEMORY.md`. Trims `MEMORY.md` if it grows past ~150 lines by consolidating older sections.

Both use the existing `memory/` directory and `MEMORY.md` — no new storage systems.

## Data Flow

### Observer Output (appended to `memory/YYYY-MM-DD.md`)

```markdown
## Observed at 14:32 CT (messages 41-60)

- **Fact**: Switched embedding model to qwen3-embedding:0.6b
- **Decision**: Using Brave as default browser for OpenClaw
- **Task**: TODO: Persist pi-ai patches as pnpm patches
- **Preference**: No local AI on the Mac — inference runs on Arch PC
```

### Reflector Output (appended to `MEMORY.md`)

```markdown
## Auto-distilled: 2026-03-06

- **Built**: Lazy tool loading + PTC for OpenClaw (42% token savings)
- **System**: Gateway auth token hardcoded, Mac mini paired as node
- **Task**: TODO: Persist pi-ai patches before next pnpm install
```

### State File (`~/.openclaw/extensions/memory-loop/state.json`)

```json
{
  "messageCount": 0,
  "lastObservedTimestamp": "2026-03-06T20:32:00Z",
  "lastReflectionDate": "2026-03-06"
}
```

## Extension Structure

```
extensions/memory-loop/
  package.json
  src/
    index.ts          # plugin entry — registers hook + cron
    observer.ts       # message counter, transcript reader, extraction
    reflector.ts      # daily summary, MEMORY.md distill + trim
    state.ts          # read/write state.json
    prompts.ts        # extraction + reflection prompt templates
```

## Implementation Details

- **Model**: Plugin SDK `generateText`, configurable, defaults to `haiku`. ~$0.01-0.05/day.
- **Hook**: `message:received`, filters to inbound user messages only (not bot replies, not group messages unless from owner). Increments counter, fires observer at 20.
- **Cron**: `0 6 * * *` UTC (midnight CT). Catches up on next startup if gateway was down.
- **Error handling**: Fire-and-forget. Model call failures logged but don't block the message pipeline. Atomic state file writes.
- **Config**:

```json
"memory-loop": {
  "enabled": true,
  "observeEvery": 20,
  "reflectCron": "0 6 * * *",
  "model": "haiku"
}
```
