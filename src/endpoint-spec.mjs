import { ms } from "./faults.mjs";
import { UsageError } from "./errors.mjs";

const KINDS = {
  static: "STATIC",
  graphql: "GRAPHQL",
  soap: "SOAP",
  "openai-chat": "OPENAI_CHAT",
  "openai-responses": "OPENAI_RESPONSES",
  "anthropic-messages": "ANTHROPIC_MESSAGES",
};
export const KIND_NAMES = Object.keys(KINDS);
export const kindToApi = (k) => {
  if (k == null) return undefined;
  const v = KINDS[String(k).toLowerCase()] ?? (Object.values(KINDS).includes(String(k).toUpperCase()) ? String(k).toUpperCase() : null);
  if (!v) throw new UsageError(`Unknown endpoint kind "${k}"; use ${KIND_NAMES.join(", ")}`);
  return v;
};
export const kindFromApi = (k) => Object.entries(KINDS).find(([, v]) => v === k)?.[0] ?? String(k).toLowerCase();
const isLlm = (k) => k === "OPENAI_CHAT" || k === "OPENAI_RESPONSES" || k === "ANTHROPIC_MESSAGES";

export const endpointKey = (method, path) => `${String(method).toUpperCase()} ${path}`;

/** The fields the API takes for an endpoint, from a saved endpoint. */
export function inputOf(e) {
  return {
    name: e.name,
    method: e.method,
    pathPattern: e.pathPattern,
    responseStatus: e.responseStatus,
    responseHeaders: e.responseHeaders ?? {},
    responseBody: e.responseBody ?? "",
    enabled: e.enabled,
    delayMs: e.delayMs ?? 0,
    kind: e.kind ?? "STATIC",
    template: !!e.template,
    conditionalResponses: e.conditionalResponses ?? [],
    llm: e.llm ?? null,
  };
}

const hasHeader = (h, name) => Object.keys(h ?? {}).some((k) => k.toLowerCase() === name.toLowerCase());

/**
 * A jitterbox.yaml endpoint (or command-line fields) → the API's input. Fields left out keep `base`'s values (the
 * existing endpoint when updating), else defaults.
 */
export function toInput(spec, base) {
  const method = String(spec.method ?? base?.method ?? "GET").toUpperCase();
  const path = spec.path ?? spec.pathPattern ?? base?.pathPattern;
  if (!path) throw new UsageError(`An endpoint needs a path (method ${method})`);
  const kind = kindToApi(spec.kind) ?? base?.kind ?? "STATIC";
  let headers = spec.headers ?? base?.responseHeaders ?? {};
  let body = base?.responseBody ?? (isLlm(kind) ? "" : '{\n  "ok": true\n}');
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json, null, 2);
    if (!hasHeader(headers, "Content-Type")) headers = { "Content-Type": "application/json", ...headers };
  } else if (spec.body !== undefined) body = String(spec.body);
  if (!base && spec.headers === undefined && spec.body === undefined && spec.json === undefined && !isLlm(kind))
    headers = { "Content-Type": "application/json" };
  return {
    name: spec.name ?? base?.name ?? endpointKey(method, path),
    method,
    pathPattern: path,
    responseStatus: spec.status != null ? Number(spec.status) : (base?.responseStatus ?? 200),
    responseHeaders: headers,
    responseBody: body,
    enabled: spec.enabled ?? base?.enabled ?? true,
    delayMs: spec.delay != null ? ms(spec.delay) : (base?.delayMs ?? 0),
    kind,
    template: spec.template ?? base?.template ?? false,
    conditionalResponses: spec.rules ?? base?.conditionalResponses ?? [],
    llm: isLlm(kind) ? (spec.llm ?? base?.llm ?? {}) : null,
  };
}

/** A saved endpoint → its jitterbox.yaml form, leaving out defaults. */
export function toSpec(e) {
  const s = { method: e.method, path: e.pathPattern };
  if (e.name && e.name !== endpointKey(e.method, e.pathPattern)) s.name = e.name;
  if (e.kind && e.kind !== "STATIC") s.kind = kindFromApi(e.kind);
  if (!isLlm(e.kind)) {
    s.status = e.responseStatus;
    const headers = { ...(e.responseHeaders ?? {}) };
    let parsed;
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    if (ct.includes("json") && !e.template) {
      try {
        parsed = JSON.parse(e.responseBody);
      } catch {}
    }
    if (parsed !== undefined) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type" && headers[k] === "application/json") delete headers[k];
      s.json = parsed;
    } else if (e.responseBody) s.body = e.responseBody;
    if (Object.keys(headers).length) s.headers = headers;
  } else if (e.llm) s.llm = e.llm;
  if (e.delayMs) s.delay = e.delayMs;
  if (e.template) s.template = true;
  if (e.enabled === false) s.enabled = false;
  if (e.conditionalResponses?.length) s.rules = e.conditionalResponses;
  return s;
}

/** Compares two API inputs as the server would: JSON bodies by value, header names case-insensitively. */
export function sameInput(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function canon(i) {
  let body = i.responseBody ?? "";
  try {
    body = JSON.stringify(JSON.parse(body));
  } catch {}
  const headers = Object.fromEntries(Object.entries(i.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]).sort());
  return { ...i, responseBody: body, responseHeaders: headers, llm: i.llm ? sortKeys(i.llm) : null, conditionalResponses: sortKeys(i.conditionalResponses ?? []) };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== null && v[k] !== undefined).map((k) => [k, sortKeys(v[k])]));
  return v;
}
export { sortKeys };
