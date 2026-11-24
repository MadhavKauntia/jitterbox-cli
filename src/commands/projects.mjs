import { writeConfig } from "../config.mjs";
import { pick } from "../context.mjs";
import { UsageError } from "../errors.mjs";
import { c, out, table } from "../output.mjs";
import { confirmOrFail } from "../resolve.mjs";

export async function projects(ctx, [sub = "list", ...args]) {
  const { client } = ctx;
  if (sub === "list" || sub === "ls") {
    await ctx.needPersonal("Listing projects");
    const ws = await ctx.workspace(false);
    const list = await client.get(`/api/projects${ws ? `?workspaceId=${ws.id}` : ""}`);
    const current = ctx.config.project?.id;
    out(ctx, list, () => {
      if (!list.length) return console.log("No projects yet. Create one: jitterbox projects create <name>");
      table([
        ["", "NAME", "ENDPOINTS", "SCENARIOS", "TODAY", "BASE URL"],
        ...list.map((p) => [p.id === current ? "*" : "", p.name, p.counts.endpoints, p.counts.scenarios, p.counts.requestsToday, c.dim(p.baseUrl)]),
      ]);
    });
    return 0;
  }
  if (sub === "create") {
    await ctx.needPersonal("Creating a project");
    const name = args.join(" ").trim();
    if (!name) throw new UsageError("Usage: jitterbox projects create <name> [--workspace <name>] [--use]");
    const ws = await ctx.workspace(false);
    const p = await client.post("/api/projects", { name, ...(ws ? { workspaceId: ws.id } : {}) });
    if (ctx.flags.use !== false) writeConfig({ project: { id: p.id, name: p.name } });
    out(ctx, p, () => {
      console.log(`${c.green("✓")} Created ${c.bold(p.name)}${ctx.flags.use !== false ? " and made it the current project" : ""}.`);
      console.log(`Base URL: ${p.baseUrl}`);
    });
    return 0;
  }
  if (sub === "use") {
    await ctx.needPersonal("Picking a project");
    if (!args[0]) throw new UsageError("Usage: jitterbox projects use <name|id>");
    const list = await client.get("/api/projects");
    const p = pick(list, args.join(" "), "project", (x) => [x.id, x.name, x.projectKey]);
    writeConfig({ project: { id: p.id, name: p.name } });
    out(ctx, p, () => console.log(`Using ${c.bold(p.name)} · ${p.baseUrl}`));
    return 0;
  }
  if (sub === "show") {
    if (args[0]) ctx.flags.project = args.join(" ");
    const p = await ctx.project();
    out(ctx, p, () => {
      console.log(`${c.bold(p.name)} ${c.dim(p.id)}`);
      console.log(`Base URL:  ${p.baseUrl}`);
      if (p.counts) console.log(`Endpoints: ${p.counts.endpoints} · Scenarios: ${p.counts.scenarios} · Requests today: ${p.counts.requestsToday}`);
      if (p.role) console.log(`Your role: ${p.role.toLowerCase()}`);
    });
    return 0;
  }
  if (sub === "rename") {
    const [ref, ...rest] = args;
    if (!ref || !rest.length) throw new UsageError('Usage: jitterbox projects rename <project> "<new name>"');
    ctx.flags.project = ref;
    const p = await ctx.project();
    const updated = await client.patch(`/api/projects/${p.id}`, { name: rest.join(" ") });
    out(ctx, updated, () => console.log(`${c.green("✓")} Renamed to ${c.bold(updated.name)}.`));
    return 0;
  }
  if (sub === "delete" || sub === "rm") {
    if (args[0]) ctx.flags.project = args.join(" ");
    const p = await ctx.project();
    confirmOrFail(ctx, `Deleting ${p.name} (its endpoints, scenarios and history)`);
    await client.del(`/api/projects/${p.id}`);
    if (ctx.config.project?.id === p.id) writeConfig({ project: null });
    out(ctx, { deleted: p.id }, () => console.log(`Deleted ${p.name}.`));
    return 0;
  }
  throw new UsageError(`Unknown projects command "${sub}"`, "Try: jitterbox projects list | create | use | show | rename | delete");
}
