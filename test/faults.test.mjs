import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRule, fromRule, ms, msRange, parseFaultFlag, toRule } from "../src/faults.mjs";

test("durations and ranges", () => {
  assert.equal(ms("200ms"), 200);
  assert.equal(ms("2s"), 2000);
  assert.equal(ms("1.5s"), 1500);
  assert.equal(ms(300), 300);
  assert.deepEqual(msRange("200-800ms"), [200, 800]);
  assert.deepEqual(msRange("0.5-3s"), [500, 3000]);
  assert.deepEqual(msRange("2s"), [2000, 2000]);
  assert.throws(() => ms("soon"));
});

test("compact faults become API rules, with rates and patterns", () => {
  assert.deepEqual(toRule({ error: 503, rate: "20%" }), { type: "HTTP_ERROR", trigger: { mode: "PROBABILITY", percent: 20 }, config: { status: 503 } });
  assert.deepEqual(toRule({ error: 429, rate: "1 in 5" }).trigger, { mode: "PROBABILITY", percent: 20 });
  assert.deepEqual(toRule({ latency: "200-800ms" }), { type: "LATENCY", trigger: { mode: "ALWAYS" }, config: { minMs: 200, maxMs: 800 } });
  assert.deepEqual(toRule({ timeout: "10s", rate: "always" }), { type: "TIMEOUT", trigger: { mode: "ALWAYS" }, config: { delayMs: 10000 } });
  assert.deepEqual(toRule({ error: 500, pattern: "xx." }).trigger, { mode: "SEQUENCE", pattern: [true, true, false], repeat: true });
  assert.deepEqual(toRule({ malformed: "invalid_json" }).config, { mode: "INVALID_JSON" });
  assert.deepEqual(toRule({ stream_cut: "40%" }).config, { atPercent: 40 });
  assert.deepEqual(toRule({ missing_done: true }).type, "MISSING_DONE");
  assert.throws(() => toRule({ error: 500, latency: "1s" }), /one kind/);
  assert.throws(() => toRule({ rate: "20%" }), /needs a kind/);
  const raw = { type: "HTTP_ERROR", trigger: { mode: "ALWAYS" }, config: { status: 418 } };
  assert.equal(toRule(raw), raw);
});

test("rules round-trip through the compact form", () => {
  for (const f of [
    { error: 503, rate: "20%" },
    { latency: "200-800ms" },
    { latency: "0.5-3s", rate: "30%" },
    { timeout: "10s" },
    { error: 500, pattern: "xx.", repeat: false },
    { graphql_error: "UNAUTHENTICATED", message: "no" },
  ])
    assert.deepEqual(toRule(fromRule(toRule(f))), toRule(f));
});

test("--fault strings", () => {
  assert.deepEqual(parseFaultFlag("error=503 rate=20%"), { error: "503", rate: "20%" });
  assert.deepEqual(parseFaultFlag("error=429 rate='1 in 5'"), { error: "429", rate: "1 in 5" });
  assert.deepEqual(parseFaultFlag('{"latency":"1s"}'), { latency: "1s" });
  assert.equal(describeRule(toRule(parseFaultFlag("error=503 rate=20%"))), "fail with 503 on 20% of requests");
});
