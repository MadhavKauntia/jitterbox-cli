import { readFileSync } from "node:fs";
import { UsageError } from "../errors.mjs";
import { endpointKey, inputOf, kindFromApi, toInput, toSpec } from "../endpoint-spec.mjs";
import { c, methodColor, out, statusColor, table } from "../output.mjs";
import { confirmOrFail, findEndpoint } from "../resolve.mjs";

export const ENDPOINT_FLAGS = {
  status: "string",
  body: "string",
  "body-file": "string",
  "json-body": "string",
  header: "list",
  delay: "string",
  name: "string",
  kind: "string",
  template: "bool",
  enabled: "bool",
  method: "string",
  path: "string",
  replace: "bool",
  "base-path": "string",
};

/** Command-line fields → a jitterbox.yaml-style endpoint (only what was given). */
function specFromFlags(f) {
  const s = {};
  if (f.method) s.method = f.method;
  if (f.path) s.path = f.path;
  if (f.name) s.name = f.name;
  if (f.status) s.status = Number(f.status);
  if (f.delay) s.delay = f.delay;
  if (f.kind) s.kind = f.kind;
  if (f.template !== undefined) s.template = f.template;
  if (f.enabled !== undefined) s.enabled = f.enabled;
  const bodies = [f.body, f.bodyFile, f.jsonBody].filter((x) => x !== undefined);
  if (bodies.length > 1) throw new UsageError("Use one of --body, --body-file and --json-body");
  if (f.jsonBody !== undefined) {
    try {
      s.json = JSON.parse(f.jsonBody);
    } catch {
      throw new UsageError("--json-body isn't valid JSON");
    }
  }
  if (f.body !== undefined) s.body = f.body;
  if (f.bodyFile !== undefined) {
    const text = readFileSync(f.bodyFile, "utf8");
    try {
      s.json = JSON.parse(text);
    } catch {
      s.body = text;
    }
  }
  if (f.header) {
    s.headers = {};
    for (const h of f.header) {
      const i = h.indexOf(":");
      if (i < 1) throw new UsageError(`--header "${h}": use "Name: value"`);
      s.headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
  }
  return s;
}

const line = (e) => `${methodColor(e.method)(e.method.padEnd(6))} ${e.pathPattern}`;

export async function endpoints(ctx, [sub = "list", ...args]) {
  const { client, flags } = ctx;
  const project = await ctx.project();
  const base = `/api/projects/${project.id}/endpoints`;
  const all = () => client.get(base);

  if (sub === "list" || sub === "ls") {
    const list = await all();
    out(ctx, list, () => {
      if (!list.length) return console.log(`No endpoints in ${project.name} yet. Add one: jitterbox endpoints create POST /payments --status 201`);
      table([
        ["ENDPOINT", "REPLY", "RULES", "24H", "STATUS"],
        ...list.map((e) => [
          line(e),
          e.kind === "STATIC" || e.kind === "GRAPHQL" || e.kind === "SOAP" ? statusColor(e.responseStatus)(e.responseStatus) : kindFromApi(e.kind),
          e.conditionalResponses?.length || "—",
          e.requests24h,
          e.enabled ? c.green("live") : c.dim("paused"),
        ]),
      ]);
      console.log(c.dim(`\nBase URL: ${project.baseUrl}`));
    });
    return 0;
  }

  if (sub === "show" || sub === "get") {
    if (!args.length) throw new UsageError('Usage: jitterbox endpoints show "<METHOD /path>"|<id>');
    const e = findEndpoint(await all(), args.join(" "));
    out(ctx, e, () => {
      console.log(`${line(e)}  ${e.enabled ? c.green("live") : c.dim("paused")}  ${c.dim(e.id)}`);
      console.log(`URL: ${project.baseUrl.replace(/\/$/, "")}${e.pathPattern}`);
      const s = toSpec(e);
      delete s.method;
      delete s.path;
      console.log(JSON.stringify(s, null, 2));
    });
    return 0;
  }

  if (sub === "create" || sub === "add") {
    let [method, path] = args;
    if (method?.startsWith("/") && !path) [method, path] = ["GET", method];
    if (!method || !path) throw new UsageError("Usage: jitterbox endpoints create <METHOD> <path> [--status 201] [--json-body '{…}'] [--header 'Name: value'] [--delay 200ms]");
    const input = toInput({ ...specFromFlags(flags), method, path });
    const e = await client.post(base, input);
    out(ctx, e, () => console.log(`${c.green("✓")} ${line(e)} is live at ${project.baseUrl.replace(/\/$/, "")}${e.pathPattern}`));
    return 0;
  }

  if (sub === "update" || sub === "edit") {
    if (!args.length) throw new UsageError('Usage: jitterbox endpoints update "<METHOD /path>" [--status …] [--json-body …] [--enabled|--no-enabled] …');
    const e = findEndpoint(await all(), args.join(" "));
    const input = toInput(specFromFlags(flags), inputOf(e));
    const saved = await client.put(`/api/endpoints/${e.id}`, input);
    out(ctx, saved, () => console.log(`${c.green("✓")} Saved ${line(saved)}`));
    return 0;
  }

  if (sub === "delete" || sub === "rm") {
    if (!args.length) throw new UsageError('Usage: jitterbox endpoints delete "<METHOD /path>" --yes');
    const e = findEndpoint(await all(), args.join(" "));
    confirmOrFail(ctx, `Deleting ${endpointKey(e.method, e.pathPattern)}`);
    await client.del(`/api/endpoints/${e.id}`);
    out(ctx, { deleted: e.id }, () => console.log(`Deleted ${line(e)}.`));
    return 0;
  }

  if (sub === "import") {
    if (!args[0]) throw new UsageError("Usage: jitterbox endpoints import <openapi.yaml|json> [--replace] [--base-path /v1]");
    const spec = readFileSync(args[0], "utf8");
    const body = { spec, onConflict: flags.replace ? "replace" : "skip", ...(flags.basePath !== undefined ? { basePath: flags.basePath } : {}) };
    const r = await client.post(`/api/projects/${project.id}/openapi/import`, body);
    out(ctx, r, () => {
      console.log(`${c.green("✓")} Created ${r.created}, replaced ${r.replaced}, skipped ${r.skipped.length}.`);
      for (const s of r.skipped) console.log(c.dim(`  skipped ${s.method} ${s.pathPattern}: ${s.reason}`));
    });
    return 0;
  }

  throw new UsageError(`Unknown endpoints command "${sub}"`, "Try: jitterbox endpoints list | show | create | update | delete | import");
}
