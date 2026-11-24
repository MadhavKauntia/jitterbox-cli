import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CliError, UsageError } from "../errors.mjs";
import { endpointKey, inputOf, sameInput, sortKeys, toInput, toSpec } from "../endpoint-spec.mjs";
import { fromRule, toRule } from "../faults.mjs";
import { c, info } from "../output.mjs";
import { pick } from "../context.mjs";

export const SPEC_FLAGS = { file: "string", "dry-run": "bool", prune: "bool", force: "bool", "exit-code": "bool" };
export const DEFAULT_FILE = "jitterbox.yaml";

async function yaml() {
  try {
    return (await import("yaml")).default;
  } catch {
    throw new CliError("The yaml package is missing.", { hint: "Install the CLI with npm (npx jitterbox …) so its dependencies come along." });
  }
}

/** Reads jitterbox.yaml (or --file). Exported so `project:` in it can pick the project for other commands. */
export async function readSpec(file) {
  if (!existsSync(file)) throw new CliError(`No ${file} here.`, { exitCode: 7, code: "not_found", hint: "Write one, or start from your project: `jitterbox pull`." });
  let doc;
  try {
    doc = (await yaml()).parse(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new UsageError(`${file} isn't valid YAML: ${e.message}`);
  }
  if (typeof doc !== "object" || Array.isArray(doc)) throw new UsageError(`${file} should be a mapping with project, endpoints and scenarios`);
  for (const k of Object.keys(doc))
    if (!["project", "workspace", "endpoints", "scenarios"].includes(k)) throw new UsageError(`${file}: unknown top-level key "${k}"`);
  return { project: doc.project, workspace: doc.workspace, endpoints: doc.endpoints ?? [], scenarios: doc.scenarios ?? [] };
}

/** Peeks at `project:` without failing (used before the context is built). */
export function specProjectHint(file = DEFAULT_FILE) {
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, "utf8").match(/^project:\s*["']?([^"'#\n]+?)["']?\s*(#.*)?$/m);
  return m?.[1]?.trim();
}

const scenarioOf = (s, epsById) => ({
  name: s.name,
  enabled: s.enabled,
  priority: s.priority,
  endpoints: s.endpointIds.map((id) => epsById.get(id)).filter(Boolean).sort(),
  rules: sortKeys(s.rules),
});

/** Works out what `apply` would do: creates, updates and (with --prune) deletes, endpoints before scenarios. */
async function plan(ctx, spec, { prune }) {
  const { client } = ctx;
  let project = null;
  try {
    project = await ctx.project();
  } catch (e) {
    if (!(e instanceof CliError && e.exitCode === 7 && spec.project)) throw e;
  }
  const existingEps = project ? await client.get(`/api/projects/${project.id}/endpoints`) : [];
  const existingScs = project ? await client.get(`/api/projects/${project.id}/scenarios`) : [];
  const changes = [];

  const seen = new Set();
  for (const raw of spec.endpoints) {
    if (!raw?.path) throw new UsageError(`Every endpoint needs a path (got ${JSON.stringify(raw)})`);
    const key = endpointKey(raw.method ?? "GET", raw.path);
    if (seen.has(key)) throw new UsageError(`${key} appears twice in the file`);
    seen.add(key);
    const ex = existingEps.find((e) => endpointKey(e.method, e.pathPattern) === key);
    const input = toInput(raw, ex ? inputOf(ex) : undefined);
    if (!ex) changes.push({ op: "create", kind: "endpoint", key, input });
    else if (!sameInput(input, inputOf(ex))) {
      const before = inputOf(ex);
      const fields = Object.keys(input).filter((k) => !sameInput({ ...before, [k]: input[k] }, before));
      changes.push({ op: "update", kind: "endpoint", key, id: ex.id, input, fields });
    }
  }
  const keyById = new Map(existingEps.map((e) => [e.id, endpointKey(e.method, e.pathPattern)]));
  const finalKeys = new Set([...existingEps.map((e) => endpointKey(e.method, e.pathPattern)), ...seen]);

  const names = new Set();
  for (const raw of spec.scenarios) {
    if (!raw?.name) throw new UsageError("Every scenario needs a name");
    if (names.has(raw.name.toLowerCase())) throw new UsageError(`Scenario "${raw.name}" appears twice in the file`);
    names.add(raw.name.toLowerCase());
    const refs = (raw.endpoints ?? []).map((r) => {
      const m = String(r).trim().match(/^([A-Za-z]+)\s+(\/\S*)$/);
      const key = m ? endpointKey(m[1], m[2]) : [...finalKeys].find((k) => k.endsWith(" " + String(r).trim()));
      if (!key || !finalKeys.has(key)) throw new UsageError(`Scenario "${raw.name}" refers to ${r}, which isn't an endpoint`);
      return key;
    });
    const wanted = {
      name: raw.name,
      enabled: raw.enabled ?? true,
      priority: raw.priority ?? 0,
      endpoints: [...refs].sort(),
      rules: sortKeys((raw.faults ?? []).map(toRule)),
    };
    const ex = existingScs.find((s) => s.name.toLowerCase() === raw.name.toLowerCase());
    if (!ex) changes.push({ op: "create", kind: "scenario", key: raw.name, wanted });
    else {
      const have = scenarioOf(ex, keyById);
      const fields = Object.keys(wanted).filter((k) => JSON.stringify(wanted[k]) !== JSON.stringify(have[k]));
      if (fields.length) changes.push({ op: "update", kind: "scenario", key: raw.name, id: ex.id, wanted, fields });
    }
  }

  if (prune) {
    for (const s of existingScs) if (!names.has(s.name.toLowerCase())) changes.push({ op: "delete", kind: "scenario", key: s.name, id: s.id });
    for (const e of existingEps) {
      const key = endpointKey(e.method, e.pathPattern);
      if (!seen.has(key)) changes.push({ op: "delete", kind: "endpoint", key, id: e.id });
    }
  }
  return { project, changes };
}

function show(changes, projectName, creatingProject) {
  if (creatingProject) console.log(`${c.green("+")} project ${projectName}`);
  if (!changes.length && !creatingProject) return console.log(`${projectName} already matches the file.`);
  for (const ch of changes) {
    const sym = ch.op === "create" ? c.green("+") : ch.op === "update" ? c.yellow("~") : c.red("-");
    console.log(`${sym} ${ch.kind} ${ch.kind === "scenario" ? `"${ch.key}"` : ch.key}${ch.fields ? c.dim(`  (${ch.fields.join(", ")})`) : ""}`);
  }
}

const summary = (changes) => changes.map(({ op, kind, key, fields }) => ({ op, kind, key, ...(fields ? { fields } : {}) }));

/** Shows what `apply` would change. With --exit-code, exits 1 when there are changes. */
export async function diff(ctx) {
  const file = ctx.flags.file ?? DEFAULT_FILE;
  const spec = await readSpec(file);
  const { project, changes } = await plan(ctx, spec, { prune: !!ctx.flags.prune });
  const name = project?.name ?? spec.project;
  if (ctx.flags.json) process.stdout.write(JSON.stringify({ project: name, createProject: !project, changes: summary(changes) }, null, 2) + "\n");
  else show(changes, name, !project);
  return ctx.flags.exitCode && (changes.length || !project) ? 1 : 0;
}

/** Makes the project match jitterbox.yaml: creates the project if needed, then endpoints, then scenarios. */
export async function apply(ctx) {
  if (ctx.flags.dryRun) return diff(ctx);
  const file = ctx.flags.file ?? DEFAULT_FILE;
  const spec = await readSpec(file);
  const { client } = ctx;
  let { project, changes } = await plan(ctx, spec, { prune: !!ctx.flags.prune });
  const created = !project;
  if (!project) {
    await ctx.needPersonal("Creating a project");
    let workspaceId;
    if (spec.workspace) workspaceId = pick(await ctx.workspaces(), spec.workspace, "workspace", (w) => [w.id, w.name]).id;
    else workspaceId = (await ctx.workspace(false))?.id;
    project = await client.post("/api/projects", { name: String(spec.project), ...(workspaceId ? { workspaceId } : {}) });
    info(`${c.green("+")} created project ${project.name}`);
  }
  const pid = project.id;
  for (const ch of changes.filter((x) => x.kind === "scenario" && x.op === "delete")) await client.del(`/api/scenarios/${ch.id}`);
  for (const ch of changes.filter((x) => x.kind === "endpoint")) {
    if (ch.op === "create") await client.post(`/api/projects/${pid}/endpoints`, ch.input);
    else if (ch.op === "update") await client.put(`/api/endpoints/${ch.id}`, ch.input);
    else await client.del(`/api/endpoints/${ch.id}`);
  }
  const eps = await client.get(`/api/projects/${pid}/endpoints`);
  const idByKey = new Map(eps.map((e) => [endpointKey(e.method, e.pathPattern), e.id]));
  for (const ch of changes.filter((x) => x.kind === "scenario" && x.op !== "delete")) {
    const body = { name: ch.wanted.name, enabled: ch.wanted.enabled, priority: ch.wanted.priority, endpointIds: ch.wanted.endpoints.map((k) => idByKey.get(k)), rules: ch.wanted.rules };
    if (ch.op === "create") await client.post(`/api/projects/${pid}/scenarios`, body);
    else await client.put(`/api/scenarios/${ch.id}`, body);
  }
  if (ctx.flags.json)
    process.stdout.write(JSON.stringify({ project: { id: pid, name: project.name, baseUrl: project.baseUrl }, createdProject: created, changes: summary(changes) }, null, 2) + "\n");
  else {
    show(changes, project.name, false);
    console.log(changes.length ? `${c.green("✓")} Applied ${changes.length} change${changes.length === 1 ? "" : "s"} to ${project.name}. Base URL: ${project.baseUrl}` : "");
  }
  return 0;
}

/** Writes the project's endpoints and scenarios to jitterbox.yaml (or --file, or - for stdout). */
export async function pull(ctx) {
  const file = ctx.flags.file ?? DEFAULT_FILE;
  if (file !== "-" && existsSync(file) && !ctx.flags.force) throw new UsageError(`${file} already exists. Add --force to overwrite it.`);
  const { client } = ctx;
  const project = await ctx.project();
  const [eps, scs] = await Promise.all([client.get(`/api/projects/${project.id}/endpoints`), client.get(`/api/projects/${project.id}/scenarios`)]);
  const keyById = new Map(eps.map((e) => [e.id, endpointKey(e.method, e.pathPattern)]));
  const doc = {
    project: project.name,
    endpoints: eps.map(toSpec),
    scenarios: scs.map((s) => {
      const o = { name: s.name };
      if (!s.enabled) o.enabled = false;
      if (s.priority) o.priority = s.priority;
      if (s.endpointIds.length) o.endpoints = s.endpointIds.map((id) => keyById.get(id)).filter(Boolean);
      o.faults = s.rules.map(fromRule);
      return o;
    }),
  };
  const text = `# Jitterbox: ${project.name} (${project.baseUrl})\n# Edit, then run \`jitterbox apply\`. Docs: \`jitterbox guide\`.\n` + (await yaml()).stringify(doc, { lineWidth: 0 });
  if (file === "-") process.stdout.write(text);
  else {
    writeFileSync(file, text);
    if (ctx.flags.json) process.stdout.write(JSON.stringify({ file, endpoints: eps.length, scenarios: scs.length }) + "\n");
    else console.log(`${c.green("✓")} Wrote ${file}: ${eps.length} endpoint${eps.length === 1 ? "" : "s"}, ${scs.length} scenario${scs.length === 1 ? "" : "s"}.`);
  }
  return 0;
}
