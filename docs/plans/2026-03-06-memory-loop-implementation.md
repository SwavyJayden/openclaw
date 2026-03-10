# Memory Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an OpenClaw extension that autonomously observes sessions (every 20 inbound user messages) and reflects daily (midnight CT), writing to existing `memory/` files.

**Architecture:** Plugin at `extensions/memory-loop/` using `message_received` hook for counting + `runEmbeddedPiAgent` for LLM calls. State persisted in JSON, output in existing markdown files.

**Tech Stack:** TypeScript, OpenClaw plugin SDK, `runEmbeddedPiAgent` for inference, `fs` for file I/O.

---

### Task 1: Scaffold Extension

**Files:**

- Create: `extensions/memory-loop/package.json`
- Create: `extensions/memory-loop/openclaw.plugin.json`
- Create: `extensions/memory-loop/src/index.ts` (empty shell)

**Step 1: Create package.json**

```json
{
  "name": "@openclaw/memory-loop",
  "version": "2026.3.3",
  "private": true,
  "description": "Autonomous memory observer and daily reflector",
  "type": "module",
  "peerDependencies": {
    "openclaw": ">=2026.3.2"
  },
  "peerDependenciesMeta": {
    "openclaw": { "optional": true }
  },
  "openclaw": {
    "extensions": ["./src/index.ts"]
  }
}
```

**Step 2: Create openclaw.plugin.json**

```json
{
  "id": "memory-loop",
  "kind": "memory",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "observeEvery": { "type": "number", "default": 20 },
      "reflectCron": { "type": "string", "default": "0 6 * * *" },
      "model": { "type": "string", "default": "haiku" }
    }
  }
}
```

**Step 3: Create empty index.ts**

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-loop";

export default function register(api: OpenClawPluginApi) {
  api.logger.info("memory-loop: registered");
}
```

**Step 4: Add to workspace pnpm-workspace.yaml if needed, install deps**

Run: `cd extensions/memory-loop && npm install --omit=dev`

**Step 5: Add to openclaw.json plugins allow list**

Add `"memory-loop"` to `plugins.allow` array and `plugins.entries` in `~/.openclaw/openclaw.json`.

**Step 6: Commit**

```bash
scripts/committer "feat: scaffold memory-loop extension" extensions/memory-loop/package.json extensions/memory-loop/openclaw.plugin.json extensions/memory-loop/src/index.ts
```

---

### Task 2: State Management

**Files:**

- Create: `extensions/memory-loop/src/state.ts`

**Step 1: Write state module**

```typescript
import fs from "node:fs";
import path from "node:path";

export type MemoryLoopState = {
  messageCount: number;
  lastObservedTimestamp: string;
  lastReflectionDate: string;
};

const DEFAULT_STATE: MemoryLoopState = {
  messageCount: 0,
  lastObservedTimestamp: "",
  lastReflectionDate: "",
};

function resolveStatePath(configDir: string): string {
  const dir = path.join(configDir, "extensions", "memory-loop");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "state.json");
}

export function loadState(configDir: string): MemoryLoopState {
  const filePath = resolveStatePath(configDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(configDir: string, state: MemoryLoopState): void {
  const filePath = resolveStatePath(configDir);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(memory-loop): add state persistence" extensions/memory-loop/src/state.ts
```

---

### Task 3: Prompts

**Files:**

- Create: `extensions/memory-loop/src/prompts.ts`

**Step 1: Write prompt templates**

```typescript
export function observerPrompt(messages: string): string {
  return `You are a memory extraction system. Analyze the following conversation messages and extract important information.

For each observation, categorize it as one of:
- **Fact**: A concrete piece of information stated or discovered
- **Decision**: A choice that was made
- **Task**: Something that needs to be done (prefix with TODO:)
- **Preference**: A user preference or workflow choice
- **Built**: Something that was created or implemented
- **System**: A system/infrastructure change

Output ONLY a markdown bullet list. Each line starts with \`- **Category**: description\`.
If nothing noteworthy happened, output \`- No notable observations.\`

Do not add headers, commentary, or explanations.

MESSAGES:
${messages}`;
}

export function reflectorPrompt(todayObservations: string, currentMemory: string): string {
  return `You are a memory consolidation system. Given today's observations and the current long-term memory, produce a distilled summary of today.

Rules:
- Output a markdown section starting with \`## Auto-distilled: YYYY-MM-DD\` (use today's date)
- Each line is \`- **Category**: description\` (same categories as observations)
- Merge duplicates, drop noise, keep only what matters for future context
- Surface any unfinished TODOs
- Maximum 10 bullet points
- Do not repeat things already in long-term memory unless they changed

TODAY'S OBSERVATIONS:
${todayObservations}

CURRENT LONG-TERM MEMORY:
${currentMemory}`;
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(memory-loop): add observer and reflector prompts" extensions/memory-loop/src/prompts.ts
```

---

### Task 4: Observer

**Files:**

- Create: `extensions/memory-loop/src/observer.ts`

**Step 1: Write observer module**

The observer reads the session JSONL file to get the last N messages, formats them, calls the LLM, and appends output to `memory/YYYY-MM-DD.md`.

```typescript
import fs from "node:fs";
import path from "node:path";
import { observerPrompt } from "./prompts.js";
import type { MemoryLoopState } from "./state.js";

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

let _runAgent: RunEmbeddedPiAgentFn | null = null;
async function getRunAgent(): Promise<RunEmbeddedPiAgentFn> {
  if (_runAgent) return _runAgent;
  const mod = await import("../../../src/agents/pi-embedded-runner.js");
  _runAgent = (mod as Record<string, unknown>).runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
  return _runAgent;
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Chicago",
    hour12: false,
  });
}

function readLastMessages(sessionDir: string, count: number): string[] {
  // Find the most recent session JSONL
  const agentsDir = path.join(sessionDir, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const mainDir = path.join(agentsDir, "main", "sessions");
  if (!fs.existsSync(mainDir)) return [];

  const files = fs
    .readdirSync(mainDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (files.length === 0) return [];

  const sessionFile = path.join(mainDir, files[0]);
  const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);

  // Parse and extract user/assistant text messages
  const messages: string[] = [];
  for (const line of lines.slice(-count * 3)) {
    try {
      const msg = JSON.parse(line);
      if (msg.role === "user" && typeof msg.content === "string") {
        messages.push(`User: ${msg.content}`);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            messages.push(`Assistant: ${block.text.slice(0, 500)}`);
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return messages.slice(-count * 2);
}

export async function runObserver(params: {
  state: MemoryLoopState;
  config: Record<string, unknown>;
  workspaceDir: string;
  sessionDir: string;
  model: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const { state, config, workspaceDir, sessionDir, model, logger } = params;

  const messages = readLastMessages(sessionDir, state.messageCount);
  if (messages.length === 0) {
    logger.info("memory-loop observer: no messages to observe");
    return;
  }

  const prompt = observerPrompt(messages.join("\n"));

  try {
    const runAgent = await getRunAgent();
    const [provider, modelId] = resolveModel(model);

    const result = await runAgent({
      sessionId: `memory-loop-observe-${Date.now()}`,
      sessionFile: path.join(sessionDir, `memory-loop-tmp-${Date.now()}.json`),
      workspaceDir,
      config,
      prompt,
      timeoutMs: 30_000,
      runId: `memory-loop-observe-${Date.now()}`,
      provider,
      model: modelId,
      disableTools: true,
    });

    const text = extractText(result);
    if (!text || text.includes("No notable observations")) {
      logger.info("memory-loop observer: nothing notable");
      return;
    }

    // Append to memory/YYYY-MM-DD.md
    const memDir = path.join(workspaceDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const memFile = path.join(memDir, `${formatDate()}.md`);
    const rangeEnd = state.messageCount;
    const rangeStart = Math.max(1, rangeEnd - 19);
    const header = `\n## Observed at ${formatTime()} CT (messages ${rangeStart}-${rangeEnd})\n\n`;
    fs.appendFileSync(memFile, header + text.trim() + "\n");

    logger.info(`memory-loop observer: wrote to ${formatDate()}.md`);
  } catch (err) {
    logger.error(`memory-loop observer failed: ${String(err)}`);
  }
}

function resolveModel(model: string): [string, string] {
  if (model.includes("/")) {
    const parts = model.split("/");
    return [parts[0], parts.slice(1).join("/")];
  }
  // Shorthand defaults
  if (model === "haiku") return ["anthropic", "claude-haiku-4-5-20251001"];
  if (model === "flash") return ["google-vertex", "gemini-2.0-flash"];
  return ["anthropic", model];
}

function extractText(result: unknown): string {
  const r = result as Record<string, unknown>;
  const payloads = r.payloads as Array<{ text?: string }> | undefined;
  if (!payloads) return "";
  return payloads
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(memory-loop): add observer — extracts facts from sessions" extensions/memory-loop/src/observer.ts
```

---

### Task 5: Reflector

**Files:**

- Create: `extensions/memory-loop/src/reflector.ts`

**Step 1: Write reflector module**

```typescript
import fs from "node:fs";
import path from "node:path";
import { reflectorPrompt } from "./prompts.js";

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

let _runAgent: RunEmbeddedPiAgentFn | null = null;
async function getRunAgent(): Promise<RunEmbeddedPiAgentFn> {
  if (_runAgent) return _runAgent;
  const mod = await import("../../../src/agents/pi-embedded-runner.js");
  _runAgent = (mod as Record<string, unknown>).runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
  return _runAgent;
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function resolveModel(model: string): [string, string] {
  if (model.includes("/")) {
    const parts = model.split("/");
    return [parts[0], parts.slice(1).join("/")];
  }
  if (model === "haiku") return ["anthropic", "claude-haiku-4-5-20251001"];
  if (model === "flash") return ["google-vertex", "gemini-2.0-flash"];
  return ["anthropic", model];
}

function extractText(result: unknown): string {
  const r = result as Record<string, unknown>;
  const payloads = r.payloads as Array<{ text?: string }> | undefined;
  if (!payloads) return "";
  return payloads
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

export async function runReflector(params: {
  config: Record<string, unknown>;
  workspaceDir: string;
  sessionDir: string;
  model: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const { config, workspaceDir, sessionDir, model, logger } = params;

  const today = formatDate();
  const memDir = path.join(workspaceDir, "memory");
  const todayFile = path.join(memDir, `${today}.md`);
  const memoryFile = path.join(workspaceDir, "MEMORY.md");

  // Read today's observations
  let todayObs = "";
  try {
    todayObs = fs.readFileSync(todayFile, "utf8");
  } catch {
    logger.info("memory-loop reflector: no observations today, skipping");
    return;
  }
  if (!todayObs.trim()) {
    logger.info("memory-loop reflector: empty observations, skipping");
    return;
  }

  // Read current MEMORY.md
  let currentMemory = "";
  try {
    currentMemory = fs.readFileSync(memoryFile, "utf8");
  } catch {
    // first time
  }

  const prompt = reflectorPrompt(todayObs, currentMemory);

  try {
    const runAgent = await getRunAgent();
    const [provider, modelId] = resolveModel(model);

    const result = await runAgent({
      sessionId: `memory-loop-reflect-${Date.now()}`,
      sessionFile: path.join(sessionDir, `memory-loop-reflect-${Date.now()}.json`),
      workspaceDir,
      config,
      prompt,
      timeoutMs: 60_000,
      runId: `memory-loop-reflect-${Date.now()}`,
      provider,
      model: modelId,
      disableTools: true,
    });

    const text = extractText(result);
    if (!text) {
      logger.info("memory-loop reflector: empty result");
      return;
    }

    // Append to MEMORY.md
    fs.appendFileSync(memoryFile, "\n" + text.trim() + "\n");

    // Trim if over 150 lines
    const lines = fs.readFileSync(memoryFile, "utf8").split("\n");
    if (lines.length > 150) {
      logger.info(
        `memory-loop reflector: MEMORY.md at ${lines.length} lines, consider manual trim`,
      );
    }

    logger.info("memory-loop reflector: daily reflection complete");
  } catch (err) {
    logger.error(`memory-loop reflector failed: ${String(err)}`);
  }
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(memory-loop): add reflector — daily summary and MEMORY.md distill" extensions/memory-loop/src/reflector.ts
```

---

### Task 6: Wire Up index.ts

**Files:**

- Modify: `extensions/memory-loop/src/index.ts`

**Step 1: Wire observer hook + reflector cron into index.ts**

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-loop";
import { runObserver } from "./observer.js";
import { runReflector } from "./reflector.js";
import { loadState, saveState } from "./state.js";

type PluginCfg = {
  observeEvery?: number;
  reflectCron?: string;
  model?: string;
};

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;
  const observeEvery = cfg.observeEvery ?? 20;
  const model = cfg.model ?? "haiku";

  const configDir = api.resolvePath("~/.openclaw");
  const workspaceDir =
    api.config?.agents?.defaults?.workspace ?? api.resolvePath("~/.openclaw/workspace");
  const sessionDir = api.resolvePath("~/.openclaw");

  // --- Observer: count inbound user messages, fire every N ---
  api.on("message_received", async (event, _ctx) => {
    // Only count messages from the owner (not bots, not group noise)
    if (!event.from) return;

    try {
      const state = loadState(configDir);
      state.messageCount += 1;

      if (state.messageCount >= observeEvery) {
        api.logger.info(`memory-loop: ${state.messageCount} messages — running observer`);
        await runObserver({
          state,
          config: api.config as Record<string, unknown>,
          workspaceDir,
          sessionDir,
          model,
          logger: api.logger,
        });
        state.messageCount = 0;
        state.lastObservedTimestamp = new Date().toISOString();
      }

      saveState(configDir, state);
    } catch (err) {
      api.logger.error(`memory-loop hook error: ${String(err)}`);
    }
  });

  // --- Reflector: daily cron ---
  api.registerHook("cron", () => {}, {
    entry: {
      event: "cron",
      cron: cfg.reflectCron ?? "0 6 * * *",
      run: async () => {
        const state = loadState(configDir);
        const today = new Date().toISOString().slice(0, 10);
        if (state.lastReflectionDate === today) {
          api.logger.info("memory-loop reflector: already ran today");
          return;
        }

        api.logger.info("memory-loop: running daily reflection");
        await runReflector({
          config: api.config as Record<string, unknown>,
          workspaceDir,
          sessionDir,
          model,
          logger: api.logger,
        });

        state.lastReflectionDate = today;
        saveState(configDir, state);
      },
    },
    name: "memory-loop-reflect",
    description: "Daily memory reflection and MEMORY.md distillation",
  });

  api.logger.info(
    `memory-loop: registered (observe every ${observeEvery} messages, model: ${model})`,
  );
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(memory-loop): wire observer hook and reflector cron" extensions/memory-loop/src/index.ts
```

---

### Task 7: Plugin SDK Shim + Config

**Files:**

- Create: `src/plugin-sdk/memory-loop.ts`
- Modify: `~/.openclaw/openclaw.json` (add to plugins)

**Step 1: Create plugin SDK re-export shim**

Check existing shims (e.g. `src/plugin-sdk/memory-core.ts`) and create matching one for memory-loop:

```typescript
export type { OpenClawPluginApi } from "./core.js";
export { emptyPluginConfigSchema } from "./core.js";
```

**Step 2: Add memory-loop to openclaw.json**

Add `"memory-loop"` to `plugins.allow` and `plugins.entries`:

```json
"memory-loop": {
  "enabled": true,
  "observeEvery": 20,
  "reflectCron": "0 6 * * *",
  "model": "haiku"
}
```

**Step 3: Commit**

```bash
scripts/committer "feat(memory-loop): add plugin SDK shim and config" src/plugin-sdk/memory-loop.ts
```

---

### Task 8: Build, Install, and Smoke Test

**Step 1: Install extension deps**

```bash
cd extensions/memory-loop && npm install --omit=dev
```

**Step 2: Build OpenClaw**

```bash
pnpm build
```

**Step 3: Restart gateway**

Kill and restart gateway. Check logs for `memory-loop: registered`.

**Step 4: Send 20 test messages via Telegram**

Send messages to the bot. After the 20th, check:

- `~/.openclaw/extensions/memory-loop/state.json` — messageCount should be 0
- `~/.openclaw/workspace/memory/2026-03-06.md` — should have an "Observed at" section

**Step 5: Commit any fixes**

```bash
scripts/committer "fix(memory-loop): smoke test fixes" <files>
```
