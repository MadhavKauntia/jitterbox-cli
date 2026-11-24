import { writeConfig } from "../config.mjs";
import { pick } from "../context.mjs";
import { UsageError } from "../errors.mjs";
import { c, out, table } from "../output.mjs";

export async function workspaces(ctx, [sub = "list", ...args]) {
  const list = await ctx.workspaces();
  if (sub === "list" || sub === "ls") {
    const current = ctx.config.workspace?.id;
    out(ctx, list, () =>
      table([
        ["", "NAME", "ROLE", "MEMBERS", "PROJECTS", "ID"],
        ...list.map((w) => [w.id === current ? "*" : "", w.name + (w.personal ? c.dim(" (personal)") : ""), w.role.toLowerCase(), w.memberCount, w.projectCount, c.dim(w.id)]),
      ]),
    );
    return 0;
  }
  if (sub === "use") {
    if (!args[0]) throw new UsageError("Usage: jitterbox workspaces use <name|id>");
    const w = pick(list, args.join(" "), "workspace", (x) => [x.id, x.name]);
    writeConfig({ workspace: { id: w.id, name: w.name }, project: null });
    out(ctx, w, () => console.log(`Using workspace ${c.bold(w.name)}. Pick a project with \`jitterbox projects use <name>\`.`));
    return 0;
  }
  throw new UsageError(`Unknown workspaces command "${sub}"`, "Try: jitterbox workspaces list | use <name>");
}
