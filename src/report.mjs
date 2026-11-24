// Turning a resilience report into a verdict and into terminal / Markdown / JUnit output. Pure functions.

export const CHECK_IDS = [
  "RETRIES_TRANSIENT",
  "RESPECTS_RETRY_AFTER",
  "BACKS_OFF",
  "GIVES_UP",
  "NO_RETRY_PERMANENT",
  "KEEPS_IDEMPOTENCY_KEY",
  "TIMES_OUT",
];

/** Accepts `respects-retry-after`, `respects_retry_after`, `RESPECTS_RETRY_AFTER`. */
export function normalizeCheckId(s) {
  const id = String(s).trim().toUpperCase().replace(/-/g, "_");
  if (!CHECK_IDS.includes(id)) throw new Error(`Unknown check "${s}". Known: ${CHECK_IDS.map((c) => c.toLowerCase().replace(/_/g, "-")).join(", ")}`);
  return id;
}

/**
 * Decides pass/fail for a report.
 * - failOn "fail" (default): any FAIL check fails; "warn": FAIL or WARN.
 * - require: these checks must be PASS (NA = not exercised counts as failing them).
 * - An empty report (no operations) fails unless allowEmpty: usually the app never called Jitterbox.
 */
export function evaluate(report, { failOn = "fail", require = [], allowEmpty = false } = {}) {
  const problems = [];
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  for (const c of report.checks) {
    if (c.verdict === "FAIL" || (failOn === "warn" && c.verdict === "WARN")) {
      problems.push({ id: c.id, reason: `${c.title}: ${c.examples[0]?.detail ?? c.verdict.toLowerCase()}` });
    }
  }
  for (const id of require) {
    const c = byId[id];
    if (!c) continue;
    if (c.verdict === "NA") problems.push({ id, reason: `${c.title}: required, but nothing exercised it` });
    else if (c.verdict === "WARN" && failOn !== "warn") problems.push({ id, reason: `${c.title}: required, but warned (${c.examples[0]?.detail ?? ""})` });
  }
  const empty = report.operations === 0;
  if (empty && !allowEmpty)
    problems.push({ id: "EMPTY", reason: "No requests reached Jitterbox. Does the app use JITTERBOX_BASE_URL?" });
  const failing = new Set(problems.map((p) => p.id));
  return { ok: problems.length === 0, problems, failing, empty };
}

const MARK = { PASS: "✓", WARN: "!", FAIL: "✗", NA: "–" };
const color = (enabled) => {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: wrap(32), yellow: wrap(33), red: wrap(31), dim: wrap(2), bold: wrap(1) };
};

function counts(c) {
  if (c.verdict === "NA") return "not tested";
  return [c.pass && `${c.pass} pass`, c.warn && `${c.warn} warn`, c.fail && `${c.fail} fail`].filter(Boolean).join(" · ");
}

export function renderTerminal(report, verdict, ctx, useColor = false) {
  const k = color(useColor);
  const tint = { PASS: k.green, WARN: k.yellow, FAIL: k.red, NA: k.dim };
  const lines = [
    "",
    k.bold(`Jitterbox resilience · ${ctx.projectName}${ctx.scenarioNames?.length ? ` · ${ctx.scenarioNames.join(", ")}` : ""}`),
    k.dim(
      `${report.operations} operations · ${report.retriedOperations} retried · ${report.succeeded} succeeded · ${report.gaveUp} gave up · ${report.analyzedRequests} requests`,
    ),
    "",
  ];
  for (const c of report.checks) {
    const m = tint[c.verdict](MARK[c.verdict]);
    const flag = verdict.failing.has(c.id) ? k.red(" ← fails the run") : "";
    lines.push(`  ${m} ${c.title.padEnd(32)} ${k.dim(counts(c))}${flag}`);
    if (c.examples[0] && c.verdict !== "PASS") lines.push(`      ${k.dim(c.examples[0].detail)}`);
  }
  lines.push("");
  if (verdict.ok) lines.push(k.green("✓ Client resilience: passed"));
  else {
    lines.push(k.red("✗ Client resilience: failed"));
    for (const p of verdict.problems) lines.push(`  - ${p.reason}`);
  }
  if (ctx.reportUrl) lines.push(k.dim(`  ${ctx.reportUrl}`));
  return lines.join("\n");
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(report, verdict, ctx) {
  const out = [
    `### ${verdict.ok ? "✅" : "❌"} Jitterbox resilience: ${verdict.ok ? "passed" : "failed"}`,
    "",
    `**${esc(ctx.projectName)}**${ctx.scenarioNames?.length ? ` · ${ctx.scenarioNames.map(esc).join(", ")}` : ""} · ${report.operations} operations, ${report.retriedOperations} retried, ${report.gaveUp} gave up, ${report.analyzedRequests} requests`,
    "",
    "| | Check | Result | Example |",
    "|---|---|---|---|",
  ];
  for (const c of report.checks) {
    out.push(`| ${MARK[c.verdict]} | ${esc(c.title)}${verdict.failing.has(c.id) ? " **(fails the run)**" : ""} | ${counts(c)} | ${c.verdict !== "PASS" && c.examples[0] ? `\`${esc(c.examples[0].detail)}\`` : ""} |`);
  }
  if (!verdict.ok) {
    out.push("", ...verdict.problems.map((p) => `- ${esc(p.reason)}`));
  }
  if (ctx.reportUrl) out.push("", `[Open the full report](${ctx.reportUrl})`);
  return out.join("\n") + "\n";
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderJUnit(report, verdict, ctx) {
  const cases = report.checks.map((c) => {
    const name = xml(c.title);
    if (verdict.failing.has(c.id)) {
      const reason = verdict.problems.find((p) => p.id === c.id)?.reason ?? c.verdict;
      return `    <testcase classname="jitterbox.resilience" name="${name}"><failure message="${xml(reason)}">${xml(c.examples.map((e) => e.detail).join("\n"))}</failure></testcase>`;
    }
    if (c.verdict === "NA") return `    <testcase classname="jitterbox.resilience" name="${name}"><skipped message="not exercised"/></testcase>`;
    return `    <testcase classname="jitterbox.resilience" name="${name}"/>`;
  });
  if (verdict.failing.has("EMPTY"))
    cases.push(`    <testcase classname="jitterbox.resilience" name="Traffic reached Jitterbox"><failure message="No requests reached Jitterbox"/></testcase>`);
  const failures = cases.filter((c) => c.includes("<failure")).length;
  const skipped = cases.filter((c) => c.includes("<skipped")).length;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="jitterbox resilience: ${xml(ctx.projectName)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}
