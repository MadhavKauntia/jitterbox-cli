import { CliError, UsageError } from "./errors.mjs";
import { endpointKey } from "./endpoint-spec.mjs";

/** An endpoint by id, "METHOD /path", or a path that only one endpoint has. */
export function findEndpoint(list, ref) {
  const r = String(ref).trim();
  const byId = list.find((e) => e.id === r);
  if (byId) return byId;
  const m = r.match(/^([A-Za-z]+)\s+(\/\S*)$/);
  if (m) {
    const hit = list.find((e) => endpointKey(e.method, e.pathPattern) === endpointKey(m[1], m[2]));
    if (hit) return hit;
  } else if (r.startsWith("/")) {
    const hits = list.filter((e) => e.pathPattern === r);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new UsageError(`Several endpoints have the path ${r}; say which method, e.g. "${hits[0].method} ${r}".`);
  }
  throw new CliError(`No endpoint "${ref}".`, {
    exitCode: 7,
    code: "not_found",
    hint: list.length ? `Have: ${list.map((e) => endpointKey(e.method, e.pathPattern)).join(", ")}.` : "This project has no endpoints yet.",
  });
}

/** A scenario by id or (case-insensitive) name. */
export function findScenario(list, ref) {
  const r = String(ref).trim();
  const hit = list.find((s) => s.id === r) ?? list.filter((s) => s.name.toLowerCase() === r.toLowerCase());
  if (hit && !Array.isArray(hit)) return hit;
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new UsageError(`Several scenarios are named "${ref}"; use the id.`);
  throw new CliError(`No scenario "${ref}".`, {
    exitCode: 7,
    code: "not_found",
    hint: list.length ? `Have: ${list.map((s) => `"${s.name}"`).join(", ")}.` : "This project has no failure scenarios yet.",
  });
}

export function confirmOrFail(ctx, what) {
  if (!ctx.flags.yes) throw new UsageError(`${what} can't be undone. Add --yes to confirm.`);
}
