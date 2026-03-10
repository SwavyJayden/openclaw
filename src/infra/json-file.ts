import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Clear macOS uchg (user immutable) flag so the file can be overwritten. */
function clearImmutable(pathname: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    execFileSync("chflags", ["nouchg", pathname], { stdio: "ignore", timeout: 5000 });
  } catch {
    // File may not exist yet or flag not set — ignore.
  }
}

/** Set macOS uchg flag on auth-profiles.json to prevent external overwrites. */
function setImmutable(pathname: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    execFileSync("chflags", ["uchg", pathname], { stdio: "ignore", timeout: 5000 });
  } catch {
    // Best-effort — ignore failures.
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const isAuthProfiles =
    pathname.endsWith("auth-profiles.json") && !pathname.startsWith(os.tmpdir());
  if (isAuthProfiles) {
    clearImmutable(pathname);
  }
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
  if (isAuthProfiles) {
    setImmutable(pathname);
  }
}
