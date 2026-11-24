import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, normalizeCheckId, renderJUnit, renderMarkdown, renderTerminal } from "../src/report.mjs";

const check = (id, verdict, extra = {}) => ({
  id, title: id.toLowerCase(), description: "", verdict,
  pass: verdict === "PASS" ? 1 : 0, warn: verdict === "WARN" ? 1 : 0, fail: verdict === "FAIL" ? 1 : 0,
  examples: verdict === "PASS" || verdict === "NA" ? [] : [{ operationId: "o", executionIds: ["x"], detail: `${id} detail` }], ...extra,
});
const report = (checks, operations = 2) => ({ operations, retriedOperations: 2, succeeded: 2, gaveUp: 0, analyzedRequests: 6, checks });
const base = [check("RETRIES_TRANSIENT", "PASS"), check("RESPECTS_RETRY_AFTER", "PASS"), check("KEEPS_IDEMPOTENCY_KEY", "WARN"), check("TIMES_OUT", "NA")];

test("warnings pass by default, fail with --fail-on warn", () => {
  assert.equal(evaluate(report(base)).ok, true);
  const v = evaluate(report(base), { failOn: "warn" });
  assert.equal(v.ok, false);
  assert.deepEqual([...v.failing], ["KEEPS_IDEMPOTENCY_KEY"]);
});

test("any FAIL fails", () => {
  const v = evaluate(report([...base, check("BACKS_OFF", "FAIL")]));
  assert.equal(v.ok, false);
  assert.match(v.problems[0].reason, /BACKS_OFF detail/);
});

test("--require: not-tested and warned required checks fail", () => {
  const v = evaluate(report(base), { require: ["TIMES_OUT", "KEEPS_IDEMPOTENCY_KEY", "RETRIES_TRANSIENT"] });
  assert.deepEqual([...v.failing].sort(), ["KEEPS_IDEMPOTENCY_KEY", "TIMES_OUT"]);
});

test("no traffic fails unless allowed", () => {
  assert.equal(evaluate(report(base, 0)).ok, false);
  assert.equal(evaluate(report(base, 0)).empty, true);
  assert.equal(evaluate(report(base, 0), { allowEmpty: true }).ok, true);
});

test("check ids accept kebab-case and reject unknown ones", () => {
  assert.equal(normalizeCheckId("respects-retry-after"), "RESPECTS_RETRY_AFTER");
  assert.throws(() => normalizeCheckId("vibes"), /Unknown check/);
});

test("renderers", () => {
  const r = report([...base, check("BACKS_OFF", "FAIL")]);
  const v = evaluate(r);
  const ctx = { projectName: "p <&>", scenarioNames: ["Rate | limited"], reportUrl: "https://x/r" };
  const junit = renderJUnit(r, v, ctx);
  assert.match(junit, /tests="5" failures="1" skipped="1"/);
  assert.match(junit, /p &lt;&amp;&gt;/);
  const md = renderMarkdown(r, v, ctx);
  assert.match(md, /Jitterbox resilience: failed/);
  assert.match(md, /Rate \\\| limited/);
  assert.match(md, /\*\*\(fails the run\)\*\*/);
  const term = renderTerminal(r, v, ctx, false);
  assert.match(term, /✗ Client resilience: failed/);
  assert.doesNotMatch(term, /\x1b\[/);
});
