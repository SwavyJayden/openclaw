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
