import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { CliError, UsageError } from "../errors.mjs";
import { evaluate, normalizeCheckId, renderJUnit, renderMarkdown, renderTerminal } from "../report.mjs";
import { findScenario } from "../resolve.mjs";

export const CI_FLAGS = {
  scenario: "list",
  "fail-on": "string",
  require: "list",
  "allow-empty": "bool",
  "report-json": "string",
  junit: "string",
  markdown: "string",
  wait: "string",
  lease: "bool",
  holder: "string",
  "keep-on": "bool",
  window: "string",
  since: "string",
  endpoint: "string",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gradeOptions(flags) {
  const failOn = flags.failOn ?? "fail";
  if (!["fail", "warn"].includes(failOn)) throw new UsageError("--fail-on must be fail or warn");
  const require = (flags.require ?? []).flatMap((r) => r.split(",")).filter(Boolean).map(normalizeCheckId);
  return { failOn, require, allowEmpty: !!flags.allowEmpty };
}

function emit(ctx, report, verdict, info) {
  if (ctx.flags.json) process.stdout.write(JSON.stringify({ ok: verdict.ok, problems: verdict.problems, report }, null, 2) + "\n");
  else console.log(renderTerminal(report, verdict, info, process.stdout.isTTY));
  if (ctx.flags.reportJson) writeFileSync(ctx.flags.reportJson, JSON.stringify(report, null, 2));
  if (ctx.flags.junit) writeFileSync(ctx.flags.junit, renderJUnit(report, verdict, info));
  if (ctx.flags.markdown) appendFileSync(ctx.flags.markdown, renderMarkdown(report, verdict, info));
}

function defaultHolder() {
  const e = process.env;
  if (e.GITHUB_REPOSITORY && e.GITHUB_RUN_ID) return `${e.GITHUB_REPOSITORY}#${e.GITHUB_RUN_ID}${e.GITHUB_JOB ? `/${e.GITHUB_JOB}` : ""}`;
  if (e.CI_PIPELINE_ID) return `${e.CI_PROJECT_PATH ?? "gitlab"}#${e.CI_PIPELINE_ID}`;
  return `${hostname()} (pid ${process.pid})`;
}

async function takeLease(client, projectId, holder, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let announced = false;
  for (;;) {
    const { status, data } = await client.call("POST", `/api/projects/${projectId}/lease`, { holder, ttlSeconds: 300 }, { allow: [409] });
    if (status === 200) return data;
    if (Date.now() > deadline) throw new CliError(`Timed out waiting for the project lease: ${data?.error?.message}`, { exitCode: 5, code: "lease_timeout" });
    if (!announced) process.stderr.write(`jitterbox: waiting for another run (${data?.error?.fields?.holder ?? "unknown"}) to finish…\n`);
    announced = true;
    await sleep(5000);
  }
}

function runCommand(command, env) {
  return new Promise((resolve) => {
    // A single argument with spaces is a shell command line ("npm test -- --grep x"); otherwise exec directly.
    const useShell = command.length === 1 && /\s/.test(command[0]);
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env, shell: useShell });
    const forward = (sig) => () => child.kill(sig);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("error", (e) => {
      process.stderr.write(`jitterbox: couldn't start ${command[0]}: ${e.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}

/** Turns scenarios on, runs your tests against the project, turns them back off and grades how the client coped. */
export async function run(ctx, _args, command) {
  if (!command?.length) throw new UsageError("Give the command to run after --, e.g. jitterbox run --scenario Flaky -- npm test");
  const wanted = ctx.flags.scenario ?? [];
  if (!wanted.length) throw new UsageError("Pass at least one --scenario");
  const grade = gradeOptions(ctx.flags);
  const wait = ctx.flags.wait != null ? Number(ctx.flags.wait) : 600;
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError("--wait must be a number of seconds");
  const { client } = ctx;
  const project = await ctx.project();
  const all = await client.get(`/api/projects/${project.id}/scenarios`);
  const scenarios = wanted.map((w) => findScenario(all, w)); // check names before any waiting

  let lease = null;
  let renew = null;
  let since = new Date(Date.now() - 5000).toISOString();
  if (ctx.flags.lease !== false) {
    lease = await takeLease(client, project.id, ctx.flags.holder ?? defaultHolder(), wait);
    since = lease.serverTime;
    renew = setInterval(() => {
      client
        .post(`/api/projects/${project.id}/lease`, { holder: lease.holder, ttlSeconds: 300, leaseId: lease.leaseId })
        .catch((e) => process.stderr.write(`jitterbox: couldn't renew the lease: ${e.message}\n`));
    }, 120_000);
    renew.unref();
  }

  // Read on/off state only now, under the lease.
  for (let i = 0; i < scenarios.length; i++) scenarios[i] = await client.get(`/api/scenarios/${scenarios[i].id}`);
  const before = new Map(scenarios.map((s) => [s.id, s.enabled]));
  let exitCode;
  try {
    for (const s of scenarios) {
      await client.post(`/api/scenarios/${s.id}/reset`);
      if (!s.enabled) await client.post(`/api/scenarios/${s.id}/enable`);
    }
    process.stderr.write(`jitterbox: ${scenarios.map((s) => `"${s.name}"`).join(", ")} on · JITTERBOX_BASE_URL=${project.baseUrl}\n`);
    exitCode = await runCommand(command, {
      ...process.env,
      JITTERBOX_BASE_URL: project.baseUrl,
      JITTERBOX_PROJECT_ID: project.id,
      JITTERBOX_SCENARIOS: scenarios.map((s) => s.name).join(","),
    });
  } finally {
    if (!ctx.flags.keepOn)
      for (const s of scenarios)
        if (!before.get(s.id)) await client.post(`/api/scenarios/${s.id}/disable`).catch((e) => process.stderr.write(`jitterbox: couldn't turn "${s.name}" off: ${e.message}\n`));
    if (renew) clearInterval(renew);
    if (lease) await client.del(`/api/projects/${project.id}/lease/${lease.leaseId}`).catch(() => {});
  }

  const q = new URLSearchParams({ since });
  if (scenarios.length === 1) q.set("scenarioId", scenarios[0].id);
  const report = await client.get(`/api/projects/${project.id}/resilience?${q}`);
  const verdict = evaluate(report, grade);
  emit(ctx, report, verdict, { projectName: project.name, scenarioNames: scenarios.map((s) => s.name), reportUrl: `${ctx.apiUrl}/projects/${project.id}/resilience` });
  if (exitCode !== 0) {
    process.stderr.write(`jitterbox: the command exited with ${exitCode}\n`);
    return exitCode;
  }
  if (!verdict.ok) return verdict.empty && verdict.problems.length === 1 ? 4 : 3;
  return 0;
}

/** Grades how your client handled failures in a time window (no command is run). */
export async function report(ctx) {
  const grade = gradeOptions(ctx.flags);
  const { client } = ctx;
  const project = await ctx.project();
  const all = await client.get(`/api/projects/${project.id}/scenarios`);
  const scenarios = (ctx.flags.scenario ?? []).map((w) => findScenario(all, w));
  const q = new URLSearchParams();
  if (ctx.flags.since) q.set("since", ctx.flags.since);
  else q.set("window", ctx.flags.window ?? "1h");
  if (scenarios[0]) q.set("scenarioId", scenarios[0].id);
  if (ctx.flags.endpoint) q.set("endpointId", ctx.flags.endpoint);
  const rep = await client.get(`/api/projects/${project.id}/resilience?${q}`);
  const verdict = evaluate(rep, grade);
  emit(ctx, rep, verdict, { projectName: project.name, scenarioNames: scenarios.map((s) => s.name), reportUrl: `${ctx.apiUrl}/projects/${project.id}/resilience` });
  return verdict.ok ? 0 : verdict.empty && verdict.problems.length === 1 ? 4 : 3;
}
