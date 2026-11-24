import { UsageError } from "./errors.mjs";

/*
 * Faults in a compact, readable form, used by `--fault "error=503 rate=20%"` and by `faults:` in jitterbox.yaml.
 *
 *   error: 503                      HTTP error (body, headers optional)
 *   latency: 200-800ms | 2s         added delay (a range picks at random)
 *   timeout: 10s                    hang, then answer 504
 *   malformed: invalid_json | truncated | empty_body | wrong_content_type
 *   slow_first_token: 3s            LLM: wait before the first token
 *   slow_stream: 100-400ms          LLM: wait between chunks
 *   stream_cut: 50%                 LLM: cut the stream this far in
 *   malformed_chunk / missing_done / truncated_tool_args: true
 *   graphql_error: UNAUTHENTICATED  (message, partial, path optional)
 *   soap_fault: Server              (message, detail optional)
 *
 * When it happens (default: every request):
 *   rate: 20% | 1 in 5 | always
 *   pattern: xx. (x = fail, . = pass)  repeat: true|false (default true)
 *
 * Anything else can be written as the API's own rule: { type, trigger, config }.
 */

const SIMPLE = { malformed_chunk: "MALFORMED_CHUNK", missing_done: "MISSING_DONE", truncated_tool_args: "TRUNCATED_TOOL_ARGS" };
const TYPE_KEYS = ["error", "latency", "timeout", "malformed", "slow_first_token", "slow_stream", "stream_cut", "graphql_error", "soap_fault", ...Object.keys(SIMPLE)];

/** "200ms" → 200, "2s" → 2000, "1.5s" → 1500, 300 → 300. */
export function ms(v) {
  if (typeof v === "number") return Math.round(v);
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!m) throw new UsageError(`"${v}" isn't a duration; use e.g. 300ms or 2s`);
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === "s" ? 1000 : 1));
}

/** "200-800ms" → [200, 800]; "2s" → [2000, 2000]. A unit at the end applies to both ends. */
export function msRange(v) {
  if (typeof v === "number") return [v, v];
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s)?\s*[-–]\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!m) {
    const one = ms(s);
    return [one, one];
  }
  const unit = m[4] ?? m[2] ?? "ms";
  return [ms(`${m[1]}${m[2] ?? unit}`), ms(`${m[3]}${unit}`)];
}

function percent(v) {
  const s = String(v).trim().toLowerCase();
  if (s === "always" || s === "100%") return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+)\s*in\s*(\d+)$/);
  if (m) return Math.round((Number(m[1]) / Number(m[2])) * 10000) / 100;
  throw new UsageError(`"${v}" isn't a rate; use e.g. 20%, "1 in 5" or always`);
}

function trigger(f) {
  if (f.pattern != null) {
    const pattern = Array.isArray(f.pattern) ? f.pattern.map(Boolean) : [...String(f.pattern)].filter((ch) => ch !== " ").map((ch) => ch === "x" || ch === "X");
    return { mode: "SEQUENCE", pattern, repeat: f.repeat !== false && f.repeat !== "false" };
  }
  if (f.rate == null) return { mode: "ALWAYS" };
  const p = percent(f.rate);
  return p == null ? { mode: "ALWAYS" } : { mode: "PROBABILITY", percent: p };
}

/** A compact fault object (or an API rule) → the API's rule. */
export function toRule(f) {
  if (f && f.type && f.trigger) return f;
  const keys = TYPE_KEYS.filter((k) => f?.[k] !== undefined);
  if (keys.length !== 1)
    throw new UsageError(
      keys.length ? `A fault has one kind; got ${keys.join(" and ")}` : `A fault needs a kind: ${TYPE_KEYS.join(", ")}`,
    );
  const k = keys[0];
  const v = f[k];
  const t = trigger(f);
  switch (k) {
    case "error": {
      const config = { status: Number(v) };
      if (f.body != null) config.body = typeof f.body === "string" ? f.body : JSON.stringify(f.body);
      if (f.headers) config.headers = f.headers;
      return { type: "HTTP_ERROR", trigger: t, config };
    }
    case "latency": {
      const [minMs, maxMs] = msRange(v);
      return { type: "LATENCY", trigger: t, config: { minMs, maxMs } };
    }
    case "timeout":
      return { type: "TIMEOUT", trigger: t, config: { delayMs: ms(v) } };
    case "malformed":
      return { type: "MALFORMED_RESPONSE", trigger: t, config: { mode: String(v).toUpperCase() } };
    case "slow_first_token":
      return { type: "SLOW_FIRST_TOKEN", trigger: t, config: { delayMs: ms(v) } };
    case "slow_stream": {
      const [minMs, maxMs] = msRange(v);
      return { type: "SLOW_STREAM", trigger: t, config: { minMs, maxMs } };
    }
    case "stream_cut":
      return { type: "STREAM_CUT", trigger: t, config: { atPercent: Math.round(percent(v) ?? 50) } };
    case "graphql_error": {
      const config = { code: String(v) };
      for (const x of ["message", "partial", "path"]) if (f[x] != null) config[x] = f[x];
      return { type: "GRAPHQL_ERROR", trigger: t, config };
    }
    case "soap_fault": {
      const config = { code: String(v) };
      for (const x of ["message", "detail"]) if (f[x] != null) config[x] = f[x];
      return { type: "SOAP_FAULT", trigger: t, config };
    }
    default:
      return { type: SIMPLE[k], trigger: t, config: {} };
  }
}

const dur = (n) => (n >= 1000 && n % 100 === 0 ? `${n / 1000}s` : `${n}ms`);
const range = (a, b) => (a === b ? dur(a) : a >= 1000 && b >= 1000 && a % 100 === 0 && b % 100 === 0 ? `${a / 1000}-${b / 1000}s` : `${a}-${b}ms`);

/** The API's rule → the compact form (for `jitterbox pull` and listings). */
export function fromRule(r) {
  const c = r.config ?? {};
  let f;
  switch (r.type) {
    case "HTTP_ERROR":
      f = { error: c.status };
      if (c.body) f.body = c.body;
      if (c.headers && Object.keys(c.headers).length) f.headers = c.headers;
      break;
    case "LATENCY":
      f = { latency: range(c.minMs, c.maxMs) };
      break;
    case "TIMEOUT":
      f = { timeout: dur(c.delayMs) };
      break;
    case "MALFORMED_RESPONSE":
      f = { malformed: String(c.mode).toLowerCase() };
      break;
    case "SLOW_FIRST_TOKEN":
      f = { slow_first_token: dur(c.delayMs) };
      break;
    case "SLOW_STREAM":
      f = { slow_stream: range(c.minMs, c.maxMs) };
      break;
    case "STREAM_CUT":
      f = { stream_cut: `${c.atPercent}%` };
      break;
    case "GRAPHQL_ERROR":
      f = { graphql_error: c.code };
      for (const x of ["message", "partial", "path"]) if (c[x] != null) f[x] = c[x];
      break;
    case "SOAP_FAULT":
      f = { soap_fault: c.code };
      for (const x of ["message", "detail"]) if (c[x] != null) f[x] = c[x];
      break;
    default: {
      const k = Object.entries(SIMPLE).find(([, t]) => t === r.type)?.[0];
      if (!k) return r;
      f = { [k]: true };
    }
  }
  const t = r.trigger ?? { mode: "ALWAYS" };
  if (t.mode === "PROBABILITY") f.rate = `${t.percent}%`;
  else if (t.mode === "SEQUENCE") {
    f.pattern = t.pattern.map((x) => (x ? "x" : ".")).join("");
    if (t.repeat === false) f.repeat = false;
  }
  return f;
}

/** `--fault "error=503 rate=20% body={...}"` → a compact fault object. A JSON object is accepted too. */
export function parseFaultFlag(s) {
  const t = s.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      throw new UsageError(`--fault ${s}: not valid JSON`);
    }
  }
  const f = {};
  // key=value pairs; values may be quoted ('1 in 5' or "...") and may contain spaces inside quotes.
  const re = /([a-z_]+)(?:=("[^"]*"|'[^']*'|\S+))?/gi;
  let m;
  while ((m = re.exec(t))) {
    let v = m[2] === undefined ? true : m[2].replace(/^["']|["']$/g, "");
    if (v === "true") v = true;
    else if (v === "false") v = false;
    f[m[1].toLowerCase()] = v;
  }
  if (f.rate === true) delete f.rate;
  return f;
}

/** "fail with 503 on 20% of requests" — a one-line description of a rule. */
export function describeRule(r) {
  const f = fromRule(r);
  const when = f.rate ? ` on ${f.rate} of requests` : f.pattern ? ` in the pattern ${f.pattern}${f.repeat === false ? " (once)" : ""}` : ", every request";
  const what = f.error != null ? `fail with ${f.error}` : f.latency ? `add ${f.latency} of delay` : f.timeout ? `hang ${f.timeout}, then 504` : f.malformed ? `send ${f.malformed.replace(/_/g, " ")}` : r.type.toLowerCase().replace(/_/g, " ");
  return what + when;
}
