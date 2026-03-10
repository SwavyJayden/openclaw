import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-loop";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/memory-loop";
import { runObserver } from "./src/observer.js";
import { runReflector } from "./src/reflector.js";
import { loadState, saveState } from "./src/state.js";

type PluginConfig = {
  observeEvery?: number;
  model?: string;
};

/** Compute ms until next 06:00 UTC (midnight CT). */
function msUntilNext0600UTC(): number {
  const now = Date.now();
  const today0600 = new Date();
  today0600.setUTCHours(6, 0, 0, 0);
  let target = today0600.getTime();
  if (target <= now) {
    target += 24 * 60 * 60 * 1000; // next day
  }
  return target - now;
}

/** Format a Date as YYYY-MM-DD in America/Chicago timezone. */
function formatDateCT(date: Date): string {
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

const memoryLoopPlugin = {
  id: "memory-loop",
  name: "Memory Loop",
  description: "Autonomous memory observer and daily reflector",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const observeEvery = pluginConfig.observeEvery ?? 20;
    const model = pluginConfig.model ?? "haiku";
    const configDir = api.resolvePath("~/.openclaw");
    const workspaceDir =
      (api.config as Record<string, Record<string, Record<string, string>>>)?.agents?.defaults
        ?.workspace ?? api.resolvePath("~/.openclaw/workspace");
    const config = (api.config ?? {}) as Record<string, unknown>;

    // -- Observer: count user messages, fire observer every N --

    let messageCounter = 0;
    let observerRunning = false;

    api.on("message_received", (event: { from?: string }) => {
      // Skip bot/system messages (no sender)
      if (!event.from) return;

      messageCounter++;

      if (messageCounter >= observeEvery) {
        messageCounter = 0;

        // Guard against overlapping observer runs
        if (observerRunning) return;
        observerRunning = true;

        // Fire-and-forget: run observer asynchronously, never block pipeline
        (async () => {
          try {
            const state = loadState(configDir);
            await runObserver({
              state,
              config,
              workspaceDir,
              configDir,
              model,
              logger: api.logger,
            });
            saveState(configDir, state);
          } catch (err) {
            api.logger.error(
              `memory-loop observer: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            observerRunning = false;
          }
        })();
      }
    });

    // -- Reflector: daily timer via registerService --

    let reflectorTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleReflector() {
      const delay = msUntilNext0600UTC();
      api.logger.info(`memory-loop: reflector scheduled in ${Math.round(delay / 60_000)}m`);

      reflectorTimer = setTimeout(() => {
        (async () => {
          try {
            const state = loadState(configDir);
            const todayCT = formatDateCT(new Date());

            if (state.lastReflectionDate === todayCT) {
              api.logger.info("memory-loop: reflector already ran today, skipping");
            } else {
              await runReflector({ config, workspaceDir, model, logger: api.logger });
              state.lastReflectionDate = todayCT;
              saveState(configDir, state);
              api.logger.info("memory-loop: reflector completed");
            }
          } catch (err) {
            api.logger.error(
              `memory-loop reflector: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Schedule next day regardless of success/failure
          scheduleReflector();
        })();
      }, delay);
    }

    api.registerService({
      id: "memory-loop-reflector",
      start() {
        api.logger.info("memory-loop: starting reflector service");
        scheduleReflector();
      },
      stop() {
        if (reflectorTimer !== null) {
          clearTimeout(reflectorTimer);
          reflectorTimer = null;
        }
        api.logger.info("memory-loop: reflector service stopped");
      },
    });

    api.logger.info(`memory-loop: registered (observeEvery=${observeEvery}, model=${model})`);
  },
};

export default memoryLoopPlugin;
