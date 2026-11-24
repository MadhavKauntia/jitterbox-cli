import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Prints the guide for coding agents (the same text as AGENTS.md in the repo). */
export async function guide(ctx) {
  const text = readFileSync(fileURLToPath(new URL("../../AGENTS.md", import.meta.url)), "utf8");
  if (ctx.flags.json) process.stdout.write(JSON.stringify({ guide: text }) + "\n");
  else process.stdout.write(text);
  return 0;
}
