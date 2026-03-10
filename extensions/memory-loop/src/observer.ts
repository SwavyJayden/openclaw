import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observerPrompt } from "./prompts.js";
import type { MemoryLoopState } from "./state.js";

export type ObserverParams = {
  state: MemoryLoopState;
  config: Record<string, unknown>;
  workspaceDir: string;
  configDir: string;
  model: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
};

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  try {
    const mod = await import("../../../src/agents/pi-embedded-runner.js");
    if (typeof (mod as Record<string, unknown>).runEmbeddedPiAgent === "function") {
      return (mod as Record<string, unknown>).runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
    }
  } catch {
    // ignore — try bundled path below
  }
  const mod = await import("../../../src/agents/pi-embedded-runner.js");
  if (typeof mod.runEmbeddedPiAgent !== "function") {
    throw new Error("Internal error: runEmbeddedPiAgent not available");
  }
  return mod.runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

type ModelInfo = { provider: string; model: string };

function resolveModel(shorthand: string): ModelInfo {
  const lower = shorthand.toLowerCase().trim();
  if (lower === "haiku" || lower.includes("haiku")) {
    return { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
  }
  if (lower === "flash" || lower.includes("flash")) {
    return { provider: "google-vertex", model: "gemini-2.5-flash" };
  }
  // If it contains a slash, treat as provider/model
  if (shorthand.includes("/")) {
    const [provider, ...rest] = shorthand.split("/");
    return { provider: provider!, model: rest.join("/") };
  }
  // Default: treat the whole string as an Anthropic model id
  return { provider: "anthropic", model: shorthand };
}

/** Format a Date as HH:MM in America/Chicago timezone. */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Chicago",
  });
}

/** Format a Date as YYYY-MM-DD in America/Chicago timezone. */
function formatDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/Chicago",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

type SessionLine = {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
};

/**
 * Read the most recent session JSONL and extract user/assistant messages
 * starting from the given message index.
 */
export function readLastMessages(
  configDir: string,
  fromIndex: number,
): { messages: string; startIdx: number; endIdx: number; totalMessages: number } | null {
  const sessionsDir = path.join(configDir, "agents", "main", "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    return null;
  }

  // Most recent session file = last after sorting by name
  const latestFile = path.join(sessionsDir, files[files.length - 1]!);
  const raw = fs.readFileSync(latestFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // Extract only message lines with user/assistant roles
  const allMessages: Array<{ idx: number; role: string; text: string }> = [];
  let messageIdx = 0;
  for (const line of lines) {
    let parsed: SessionLine;
    try {
      parsed = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    if (parsed.type !== "message" || !parsed.message) {
      continue;
    }
    const { role, content } = parsed.message;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text ?? "")
        .join("\n");
    }

    if (text.trim()) {
      allMessages.push({ idx: messageIdx, role, text: text.trim() });
    }
    messageIdx++;
  }

  if (allMessages.length === 0 || fromIndex >= allMessages.length) {
    return null;
  }

  const slice = allMessages.slice(fromIndex);
  if (slice.length === 0) {
    return null;
  }

  const formatted = slice
    .map((m) => {
      const label = m.role === "user" ? "User" : "Assistant";
      return `${label}: ${m.text}`;
    })
    .join("\n\n");

  return {
    messages: formatted,
    startIdx: fromIndex,
    endIdx: allMessages.length - 1,
    totalMessages: allMessages.length,
  };
}

/**
 * Run the observer: read recent session messages, call the LLM to extract
 * observations, and append them to the daily memory file.
 *
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function runObserver(params: ObserverParams): Promise<void> {
  const { state, config, workspaceDir, configDir, model, logger } = params;

  try {
    const result = readLastMessages(configDir, state.messageCount);
    if (!result) {
      logger.info("observer: no new messages to observe");
      return;
    }

    const { messages, startIdx, endIdx, totalMessages } = result;
    logger.info(`observer: processing messages ${startIdx}-${endIdx} (${totalMessages} total)`);

    // Read today's existing observations for dedup
    const now = new Date();
    const dateStr = formatDate(now);
    const memoryDir = path.join(workspaceDir, "memory");
    const memoryFile = path.join(memoryDir, `${dateStr}.md`);
    const recentObservations = fs.existsSync(memoryFile)
      ? fs.readFileSync(memoryFile, "utf8").trim()
      : "";

    const { provider, model: modelId } = resolveModel(model);
    const prompt = observerPrompt(messages, recentObservations);

    let tmpDir: string | null = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-observer-"));
      const sessionId = `memory-observer-${Date.now()}`;
      const sessionFile = path.join(tmpDir, "session.json");

      const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

      const agentResult = await runEmbeddedPiAgent({
        sessionId,
        sessionFile,
        workspaceDir,
        config,
        prompt,
        timeoutMs: 30_000,
        runId: `memory-observer-${Date.now()}`,
        provider,
        model: modelId,
        disableTools: true,
      });

      const text = collectText(
        (agentResult as Record<string, unknown>).payloads as
          | Array<{ text?: string; isError?: boolean }>
          | undefined,
      );

      if (!text) {
        logger.info("observer: LLM returned empty output");
        // Still advance the counter so we don't re-process
        state.messageCount = totalMessages;
        return;
      }

      // Write observations to memory/YYYY-MM-DD.md
      const timeStr = formatTime(now);
      fs.mkdirSync(memoryDir, { recursive: true });
      const header = `## Observed at ${timeStr} CT (messages ${startIdx}-${endIdx})\n\n`;
      const entry = `${header}${text}\n\n`;

      fs.appendFileSync(memoryFile, entry);

      logger.info(`observer: wrote observations to memory/${dateStr}.md`);

      // Advance the message counter
      state.messageCount = totalMessages;
      state.lastObservedTimestamp = now.toISOString();
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  } catch (err) {
    logger.error(`observer: ${err instanceof Error ? err.message : String(err)}`);
  }
}
