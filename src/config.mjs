import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where `jitterbox login` keeps the token and your current project: $JITTERBOX_CONFIG, else ~/.config/jitterbox. */
export function configPath() {
  if (process.env.JITTERBOX_CONFIG) return process.env.JITTERBOX_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "jitterbox", "config.json");
}

export function readConfig() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** Merges `patch` into the config (null values remove keys) and saves it readable by you only. */
export function writeConfig(patch) {
  const p = configPath();
  const next = { ...readConfig(), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {}
  return next;
}
