import { CliError, apiError } from "./errors.mjs";

export const DEFAULT_API = "https://jitterbox.xyz";
export const VERSION = "0.3.0";

/** A small client for the Jitterbox API. `token` may be absent (sign-in calls). */
export function makeClient({ apiUrl, token }) {
  const base = (apiUrl || DEFAULT_API).replace(/\/$/, "");
  const headers = (extra = {}) => ({
    "Content-Type": "application/json",
    "X-Jitterbox-Client": "cli",
    "User-Agent": `jitterbox-cli/${VERSION}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function call(method, path, body, { allow = [] } = {}) {
    let res;
    try {
      res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new CliError(`Can't reach ${base}: ${e.cause?.code ?? e.message}`, { exitCode: 1, code: "network" });
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok && !allow.includes(res.status)) throw apiError(res.status, data, `${method} ${path} failed (${res.status})`);
    return { status: res.status, data };
  }

  const get = async (path) => (await call("GET", path)).data;
  const post = async (path, body) => (await call("POST", path, body)).data;
  const put = async (path, body) => (await call("PUT", path, body)).data;
  const patch = async (path, body) => (await call("PATCH", path, body)).data;
  const del = async (path, body) => (await call("DELETE", path, body)).data;

  /** Reads a Server-Sent Events stream, calling onEvent({ event, data }) until it ends or `signal` aborts. */
  async function stream(path, onEvent, signal) {
    const res = await fetch(base + path, { headers: headers({ Accept: "text/event-stream" }), signal });
    if (!res.ok) throw apiError(res.status, await res.json().catch(() => null), `Couldn't open the live stream (${res.status})`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) onEvent({ event, data: data.join("\n") });
      }
    }
  }

  return { base, token, call, get, post, put, patch, del, stream };
}
