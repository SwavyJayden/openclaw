import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reflectorPrompt } from "./prompts.js";

export type ReflectorParams = {
  config: Record<string, unknown>;
  workspaceDir: string;
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

/**
 * Run the reflector: read today's observations and current MEMORY.md,
 * call the LLM to produce a distilled summary, and append it to MEMORY.md.
 *
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function runReflector(params: ReflectorParams): Promise<void> {
  const { config, workspaceDir, model, logger } = params;

  try {
    const now = new Date();
    const dateStr = formatDate(now);

    // Read today's observations
    const observationsFile = path.join(workspaceDir, "memory", `${dateStr}.md`);
    if (!fs.existsSync(observationsFile)) {
      logger.info("reflector: no observations file for today, skipping");
      return;
    }

    const todayObservations = fs.readFileSync(observationsFile, "utf8").trim();
    if (!todayObservations) {
      logger.info("reflector: observations file is empty, skipping");
      return;
    }

    // Read current MEMORY.md
    const memoryFile = path.join(workspaceDir, "MEMORY.md");
    const currentMemory = fs.existsSync(memoryFile)
      ? fs.readFileSync(memoryFile, "utf8").trim()
      : "";

    const { provider, model: modelId } = resolveModel(model);
    const prompt = reflectorPrompt(todayObservations, currentMemory);

    let tmpDir: string | null = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-reflector-"));
      const sessionId = `memory-reflector-${Date.now()}`;
      const sessionFile = path.join(tmpDir, "session.json");

      const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

      const agentResult = await runEmbeddedPiAgent({
        sessionId,
        sessionFile,
        workspaceDir,
        config,
        prompt,
        timeoutMs: 30_000,
        runId: `memory-reflector-${Date.now()}`,
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
        logger.info("reflector: LLM returned empty output");
        return;
      }

      // Sanity check: reject output that's too short or too long
      const outputLines = text.split("\n").length;
      if (outputLines < 10) {
        logger.info(
          `reflector: output too short (${outputLines} lines), keeping existing MEMORY.md`,
        );
        return;
      }
      if (outputLines > 200) {
        logger.info(
          `reflector: output too long (${outputLines} lines), keeping existing MEMORY.md`,
        );
        return;
      }

      // Back up current MEMORY.md before overwriting
      if (currentMemory) {
        const backupFile = path.join(path.dirname(memoryFile), `MEMORY.md.bak.${dateStr}`);
        fs.writeFileSync(backupFile, currentMemory, "utf8");
        logger.info(`reflector: backed up MEMORY.md to ${path.basename(backupFile)}`);
      }

      // Full rewrite of MEMORY.md
      fs.writeFileSync(memoryFile, `${text}\n`, "utf8");
      logger.info(`reflector: rewrote MEMORY.md (${outputLines} lines)`);
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
    logger.error(`reflector: ${err instanceof Error ? err.message : String(err)}`);
  }
}
