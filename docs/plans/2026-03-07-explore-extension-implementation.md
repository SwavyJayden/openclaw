# Explore Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Register an `explore` tool that delegates codebase exploration to a Haiku sub-agent with read-only tools.

**Architecture:** New extension under `extensions/explore/` registers an `explore` tool via `api.registerTool()`. The tool spawns a stateless Haiku sub-agent via `runEmbeddedPiAgent()` with tools enabled (read + exec). A system prompt constrains the sub-agent to read-only operations.

**Tech Stack:** TypeScript, openclaw plugin SDK, `runEmbeddedPiAgent()`, `@sinclair/typebox` for tool schema.

---

### Task 1: Create extension scaffolding

**Files:**

- Create: `extensions/explore/package.json`
- Create: `extensions/explore/openclaw.plugin.json`

**Step 1: Create `package.json`**

```json
{
  "name": "@openclaw/explore",
  "version": "2026.3.7",
  "private": true,
  "description": "Haiku-powered codebase exploration tool",
  "type": "module",
  "peerDependencies": {
    "openclaw": ">=2026.3.7"
  },
  "peerDependenciesMeta": {
    "openclaw": {
      "optional": true
    }
  },
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

**Step 2: Create `openclaw.plugin.json`**

```json
{
  "id": "explore",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

**Step 3: Commit**

```bash
scripts/committer "feat(explore): add extension scaffolding" extensions/explore/package.json extensions/explore/openclaw.plugin.json
```

---

### Task 2: Create the explorer system prompt

**Files:**

- Create: `extensions/explore/src/prompts.ts`

**Step 1: Write prompt file**

```typescript
export function explorerSystemPrompt(workspaceDir: string, scope?: string): string {
  const scopeDir = scope ?? workspaceDir;
  return `You are a codebase explorer. Your job is to answer questions about the codebase by searching and reading files.

WORKSPACE: ${workspaceDir}
SEARCH SCOPE: ${scopeDir}

RULES:
- Use exec to run grep, rg, find, ls, wc, head, tail ONLY — no other commands
- Use read to examine file contents
- Do NOT use write, edit, or any destructive tools
- Do NOT modify any files
- Be concise and direct in your findings
- Always include file paths relative to the workspace root

OUTPUT FORMAT:
- List the files you examined
- Key findings with relevant code snippets (keep snippets short — 5-15 lines max)
- A brief summary answering the query`;
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(explore): add explorer system prompt" extensions/explore/src/prompts.ts
```

---

### Task 3: Create the explore tool

**Files:**

- Create: `extensions/explore/src/explore-tool.ts`

**Step 1: Write the tool file**

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { explorerSystemPrompt } from "./prompts.js";

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  try {
    const mod = await import("../../../src/agents/pi-embedded-runner.js");
    if (typeof (mod as Record<string, unknown>).runEmbeddedPiAgent === "function") {
      return (mod as Record<string, unknown>).runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
    }
  } catch {
    // ignore — try bundled path
  }
  const mod = await import("../../../dist/extensionAPI.js");
  const fn = (mod as Record<string, unknown>).runEmbeddedPiAgent;
  if (typeof fn !== "function") {
    throw new Error("Internal error: runEmbeddedPiAgent not available");
  }
  return fn as RunEmbeddedPiAgentFn;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

const ExploreToolSchema = Type.Object({
  query: Type.String({ description: "What to explore in the codebase." }),
  scope: Type.Optional(
    Type.String({ description: "Directory to scope the search to. Defaults to workspace root." }),
  ),
});

export function createExploreTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.config ?? {}) as Record<string, unknown>;
  const workspaceDir =
    (api.config as Record<string, Record<string, Record<string, string>>>)?.agents?.defaults
      ?.workspace ?? api.resolvePath("~/.openclaw/workspace");

  return {
    name: "explore",
    label: "Explore",
    description:
      "Explore the codebase using a fast, cheap sub-agent (Haiku). Delegates grep, file reading, and search to a disposable explorer that returns a summary. Use this for codebase research, finding files, understanding how things work, or answering questions about the code.",
    parameters: ExploreToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string; scope?: string };
      const systemPrompt = explorerSystemPrompt(workspaceDir, params.scope);
      const prompt = `${systemPrompt}\n\nQUERY:\n${params.query}`;

      let tmpDir: string | null = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-explore-"));
        const sessionId = `explore-${Date.now()}`;
        const sessionFile = path.join(tmpDir, "session.json");

        const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

        const result = await runEmbeddedPiAgent({
          sessionId,
          sessionFile,
          workspaceDir,
          config,
          prompt,
          timeoutMs: 60_000,
          runId: `explore-${Date.now()}`,
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          disableTools: false,
        });

        const text = collectText(
          (result as Record<string, unknown>).payloads as
            | Array<{ text?: string; isError?: boolean }>
            | undefined,
        );

        if (!text) {
          return {
            content: [{ type: "text", text: "Explorer returned no findings." }],
          };
        }

        return {
          content: [{ type: "text", text }],
        };
      } finally {
        if (tmpDir) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        }
      }
    },
  };
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(explore): add explore tool with Haiku sub-agent" extensions/explore/src/explore-tool.ts
```

---

### Task 4: Create the plugin entry point

**Files:**

- Create: `extensions/explore/index.ts`

**Step 1: Write plugin entry**

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createExploreTool } from "./src/explore-tool.js";

const EXPLORE_AGENT_GUIDANCE = `## Explore Tool
You have access to an \`explore\` tool that delegates codebase research to a fast, cheap sub-agent.
Use it when you need to search for files, understand how something works, or find code patterns.
It's much cheaper than doing the search yourself — prefer it for broad exploration.`;

const plugin = {
  id: "explore",
  name: "Explore",
  description: "Haiku-powered codebase exploration tool",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerTool(createExploreTool(api));

    api.on("before_prompt_build", async () => ({
      prependSystemContext: EXPLORE_AGENT_GUIDANCE,
    }));

    api.logger.info("explore: registered");
  },
};

export default plugin;
```

**Step 2: Commit**

```bash
scripts/committer "feat(explore): add plugin entry point with tool registration" extensions/explore/index.ts
```

---

### Task 5: Register extension in workspace config

**Files:**

- Modify: `pnpm-workspace.yaml` (add `extensions/explore` if not auto-discovered)

**Step 1: Check if extensions are auto-discovered or need explicit registration**

```bash
grep -n "explore\|extensions" pnpm-workspace.yaml | head -10
```

If extensions need explicit listing, add `- "extensions/explore"` to the packages list.

**Step 2: Verify plugin SDK imports resolve**

```bash
cd extensions/explore && node -e "import('openclaw/plugin-sdk')" 2>&1
```

**Step 3: Commit if workspace config changed**

```bash
scripts/committer "feat(explore): register in workspace" pnpm-workspace.yaml
```

---

### Task 6: Add plugin SDK subpath for explore

**Files:**

- Check: `src/plugin-sdk/` for whether a scoped entry is needed (like `memory-loop.ts`, `diffs.ts`)
- May need to create: `src/plugin-sdk/explore.ts`

**Step 1: Check if generic `openclaw/plugin-sdk` import works**

If extensions like `diffs` use `openclaw/plugin-sdk/diffs`, we may need `src/plugin-sdk/explore.ts` that re-exports what we need. Check the `index.ts` imports in our `extensions/explore/index.ts` — if `openclaw/plugin-sdk` (no subpath) exports `OpenClawPluginApi` and `emptyPluginConfigSchema`, no subpath needed.

```bash
grep "emptyPluginConfigSchema\|OpenClawPluginApi" src/plugin-sdk/index.ts | head -5
```

If both are exported from the main entry, we're good. Otherwise, create a minimal `src/plugin-sdk/explore.ts`.

**Step 2: Commit if SDK subpath was created**

---

### Task 7: Build and verify

**Step 1: Build**

```bash
pnpm build
```

Expected: no errors.

**Step 2: Verify the explore tool is loadable**

Start gateway and check logs for `explore: registered`.

**Step 3: Commit any build config changes**

---

### Task 8: Manual smoke test

**Step 1: Send a message to the agent asking it to use explore**

Via Telegram or CLI, ask: "Use the explore tool to find how auth token refresh works"

**Step 2: Verify:**

- The main agent calls the `explore` tool
- Haiku sub-agent runs, greps/reads files
- Summary is returned to the main agent
- Main agent incorporates the findings in its response

**Step 3: Check timing** — should complete in <30s for typical queries.
