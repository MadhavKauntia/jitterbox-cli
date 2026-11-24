import { UsageError } from "./errors.mjs";

/** Flags every command understands. */
export const GLOBAL_FLAGS = {
  json: "bool",
  yes: "bool",
  help: "bool",
  quiet: "bool",
  api: "string",
  token: "string",
  project: "string",
  workspace: "string",
};

/**
 * Parses `argv` against a flag spec: { name: "bool" | "string" | "list" }. Accepts `--name value`, `--name=value`,
 * `-h`, `-y`, and `--no-name` for booleans. Everything after `--` is returned as `command`.
 */
export function parseArgs(argv, spec = {}) {
  const all = { ...GLOBAL_FLAGS, ...spec };
  const flags = {};
  const positionals = [];
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") {
      command = argv.slice(i + 1);
      break;
    }
    if (a === "-h") a = "--help";
    if (a === "-y") a = "--yes";
    if (!a.startsWith("--") || a === "-") {
      positionals.push(a);
      continue;
    }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    let type = all[name];
    if (!type && name.startsWith("no-") && all[name.slice(3)] === "bool") {
      flags[toKey(name.slice(3))] = false;
      continue;
    }
    if (!type) throw new UsageError(`Unknown option --${name}`);
    const key = toKey(name);
    if (type === "bool") {
      flags[key] = value === undefined ? true : !["false", "0", "no"].includes(value);
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      value = argv[++i];
    }
    if (type === "list") (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return { flags, positionals, command };
}

const toKey = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
