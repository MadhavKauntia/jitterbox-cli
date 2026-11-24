import { UsageError } from "../errors.mjs";
import { c, methodColor, out, relative, statusColor, table } from "../output.mjs";
import { confirmOrFail, findEndpoint } from "../resolve.mjs";

export const REQUEST_FLAGS = { status: "string", endpoint: "string", limit: "string" };

const injected = (e) => e.outcome === "FAULTED";
const result = (e) => {
  const s = e.responseStatus == null ? "no reply" : String(e.responseStatus);
  return statusColor(e.responseStatus, injected(e))(injected(e) ? `${s} on purpose` : s);
};
const oneLine = (e) =>
  `${c.dim(new Date(e.startedAt).toLocaleTimeString())}  ${result(e).padEnd(14)}  ${methodColor(e.method)(e.method.padEnd(6))} ${e.path}${e.query ? c.dim("?" + e.query) : ""}  ${c.dim(`${e.latencyMs} ms`)}`;

export async function requests(ctx, [sub = "list", ...args]) {
  const { client, flags } = ctx;
  const project = await ctx.project();

  if (sub === "list" || sub === "ls") {
    const q = new URLSearchParams({ limit: flags.limit ?? "20" });
    if (flags.status) {
      if (!["errors", "faulted", "2xx"].includes(flags.status)) throw new UsageError("--status must be errors, faulted or 2xx");
      q.set("status", flags.status);
    }
    if (flags.endpoint) q.set("endpointId", findEndpoint(await client.get(`/api/projects/${project.id}/endpoints`), flags.endpoint).id);
    const page = await client.get(`/api/projects/${project.id}/executions?${q}`);
    out(ctx, page, () => {
      if (!page.items.length) return console.log(`No requests yet. Call your base URL: curl ${project.baseUrl}`);
      table([
        ["WHEN", "RESULT", "REQUEST", "TOOK", "ID"],
        ...page.items.map((e) => [relative(e.startedAt), result(e), `${methodColor(e.method)(e.method)} ${e.path}`, `${e.latencyMs} ms`, c.dim(e.id)]),
      ]);
    });
    return 0;
  }

  if (sub === "show" || sub === "get") {
    if (!args[0]) throw new UsageError("Usage: jitterbox requests show <id>");
    const d = await client.get(`/api/executions/${args[0]}`);
    out(ctx, d, () => {
      console.log(oneLine(d));
      console.log(`Endpoint: ${d.endpointName ?? c.dim("none matched")} · seed ${d.seed}`);
      if (d.faults?.length) console.log(`Broken on purpose: ${d.faults.join(", ")}`);
      for (const ev of d.events ?? []) console.log(c.dim(`  ${ev.type.toLowerCase().replace(/_/g, " ")}`));
      if (d.response?.body) console.log(`\n${d.response.body.slice(0, 2000)}`);
    });
    return 0;
  }

  if (sub === "tail" || sub === "watch") {
    if (!flags.json) process.stderr.write(c.dim(`Listening to ${project.name} (${project.baseUrl}). Ctrl-C to stop.\n`));
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    try {
      await client.stream(
        `/api/projects/${project.id}/executions/stream`,
        ({ event, data }) => {
          if (event !== "execution") return;
          const e = JSON.parse(data);
          if (flags.json) process.stdout.write(JSON.stringify(e) + "\n");
          else console.log(oneLine(e));
        },
        ac.signal,
      );
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    }
    return 0;
  }

  if (sub === "clear") {
    confirmOrFail(ctx, `Clearing every recorded request in ${project.name}`);
    await client.del(`/api/projects/${project.id}/executions`);
    out(ctx, { cleared: true }, () => console.log("Request log cleared."));
    return 0;
  }

  throw new UsageError(`Unknown requests command "${sub}"`, "Try: jitterbox requests list | show <id> | tail | clear");
}
