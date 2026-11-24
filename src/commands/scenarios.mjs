import { UsageError } from "../errors.mjs";
import { endpointKey } from "../endpoint-spec.mjs";
import { describeRule, fromRule, parseFaultFlag, toRule } from "../faults.mjs";
import { c, out, table } from "../output.mjs";
import { confirmOrFail, findEndpoint, findScenario } from "../resolve.mjs";

export const SCENARIO_FLAGS = {
  fault: "list",
  endpoint: "list",
  "all-endpoints": "bool",
  off: "bool",
  on: "bool",
  priority: "string",
  name: "string",
  count: "string",
  seed: "string",
};

const scopeText = (s, eps) =>
  s.endpointIds.length === 0
    ? "every request"
    : s.endpointIds.map((id) => eps.find((e) => e.id === id)).map((e) => (e ? endpointKey(e.method, e.pathPattern) : "deleted endpoint")).join(", ");

export async function scenarios(ctx, [sub = "list", ...args]) {
  const { client, flags } = ctx;
  const project = await ctx.project();
  const base = `/api/projects/${project.id}/scenarios`;
  const all = () => client.get(base);
  const eps = () => client.get(`/api/projects/${project.id}/endpoints`);

  const rulesFromFlags = () => (flags.fault ?? []).map((f) => toRule(parseFaultFlag(f)));
  const scopeFromFlags = async () => {
    if (flags.allEndpoints) return [];
    if (!flags.endpoint) return undefined;
    const list = await eps();
    return flags.endpoint.map((ref) => findEndpoint(list, ref).id);
  };

  if (sub === "list" || sub === "ls") {
    const [list, endpointsList] = await Promise.all([all(), eps()]);
    out(ctx, list.map((s) => ({ ...s, faults: s.rules.map(fromRule) })), () => {
      if (!list.length) return console.log(`No failure scenarios in ${project.name} yet. Try: jitterbox scenarios create "Flaky" --fault "error=503 rate=20%"`);
      table([
        ["NAME", "ON", "APPLIES TO", "WHAT IT DOES", "FAILED 24H"],
        ...list.map((s) => [s.name, s.enabled ? c.yellow("on") : c.dim("off"), scopeText(s, endpointsList), s.rules.map(describeRule).join("; ") || "nothing yet", s.faults24h ?? 0]),
      ]);
    });
    return 0;
  }

  if (sub === "show" || sub === "get") {
    if (!args.length) throw new UsageError('Usage: jitterbox scenarios show "<name>"');
    const [list, endpointsList] = await Promise.all([all(), eps()]);
    const s = findScenario(list, args.join(" "));
    out(ctx, { ...s, faults: s.rules.map(fromRule) }, () => {
      console.log(`${c.bold(s.name)}  ${s.enabled ? c.yellow("on") : c.dim("off")}  v${s.version}  ${c.dim(s.id)}`);
      console.log(`Applies to: ${scopeText(s, endpointsList)}`);
      for (const r of s.rules) console.log(`  • ${describeRule(r)}`);
    });
    return 0;
  }

  if (sub === "create" || sub === "add") {
    const name = args.join(" ").trim() || flags.name;
    if (!name) throw new UsageError('Usage: jitterbox scenarios create "<name>" --fault "error=503 rate=20%" [--fault …] [--endpoint "POST /payments"] [--off]');
    const rules = rulesFromFlags();
    if (!rules.length) throw new UsageError('Add at least one --fault, e.g. --fault "error=503 rate=20%" or --fault "latency=200-800ms"');
    const s = await client.post(base, {
      name,
      enabled: !flags.off,
      priority: flags.priority ? Number(flags.priority) : 0,
      endpointIds: (await scopeFromFlags()) ?? [],
      rules,
    });
    out(ctx, s, () => console.log(`${c.green("✓")} Created "${s.name}" (${s.enabled ? "on" : "off"}): ${s.rules.map(describeRule).join("; ")}`));
    return 0;
  }

  if (sub === "update" || sub === "edit") {
    if (!args.length) throw new UsageError('Usage: jitterbox scenarios update "<name>" [--name …] [--fault … (replaces all)] [--endpoint …|--all-endpoints] [--on|--off]');
    const s = findScenario(await all(), args.join(" "));
    const rules = flags.fault ? rulesFromFlags() : s.rules;
    const scope = await scopeFromFlags();
    const saved = await client.put(`/api/scenarios/${s.id}`, {
      name: flags.name ?? s.name,
      priority: flags.priority ? Number(flags.priority) : s.priority,
      enabled: flags.on ? true : flags.off ? false : s.enabled,
      endpointIds: scope ?? s.endpointIds,
      rules,
    });
    out(ctx, saved, () => console.log(`${c.green("✓")} Saved "${saved.name}" as version ${saved.version}.`));
    return 0;
  }

  const toggles = { on: "enable", enable: "enable", off: "disable", disable: "disable", reset: "reset" };
  if (toggles[sub]) {
    if (!args.length) throw new UsageError(`Usage: jitterbox scenarios ${sub} "<name>"`);
    const s = findScenario(await all(), args.join(" "));
    const saved = await client.post(`/api/scenarios/${s.id}/${toggles[sub]}`);
    out(ctx, saved, () =>
      console.log(sub === "reset" ? `"${saved.name}": sequences start over.` : `"${saved.name}" is ${saved.enabled ? c.yellow("on") : "off"}.`),
    );
    return 0;
  }

  if (sub === "delete" || sub === "rm") {
    if (!args.length) throw new UsageError('Usage: jitterbox scenarios delete "<name>" --yes');
    const s = findScenario(await all(), args.join(" "));
    confirmOrFail(ctx, `Deleting "${s.name}"`);
    await client.del(`/api/scenarios/${s.id}`);
    out(ctx, { deleted: s.id }, () => console.log(`Deleted "${s.name}".`));
    return 0;
  }

  if (sub === "simulate" || sub === "preview") {
    if (!args.length) throw new UsageError('Usage: jitterbox scenarios simulate "<name>" [--count 200] [--seed 42]');
    const s = findScenario(await all(), args.join(" "));
    const r = await client.post(`/api/scenarios/${s.id}/simulate`, { count: flags.count ? Number(flags.count) : 200, ...(flags.seed ? { seed: flags.seed } : {}) });
    out(ctx, r, () => {
      console.log(`"${s.name}" over ${r.count} requests (seed ${r.seed}): ${r.injected} broken on purpose, ${r.passed} normal.`);
      console.log(`Statuses: ${Object.entries(r.statuses).map(([k, v]) => `${k}×${v}`).join(", ")} · p50 ${r.p50Ms} ms · p95 ${r.p95Ms} ms`);
    });
    return 0;
  }

  throw new UsageError(`Unknown scenarios command "${sub}"`, "Try: jitterbox scenarios list | show | create | update | on | off | reset | delete | simulate");
}
