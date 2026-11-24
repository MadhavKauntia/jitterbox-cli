import { test } from "node:test";
import assert from "node:assert/strict";
import { inputOf, sameInput, toInput, toSpec } from "../src/endpoint-spec.mjs";
import { parseArgs } from "../src/args.mjs";

const saved = {
  id: "e1", name: "Create a payment", method: "POST", pathPattern: "/payments", responseStatus: 201,
  responseHeaders: { "Content-Type": "application/json", Location: "/p/1" }, responseBody: '{\n  "id": "pay_1"\n}',
  enabled: true, delayMs: 0, kind: "STATIC", template: false, conditionalResponses: [], llm: null,
};

test("an endpoint round-trips through jitterbox.yaml", () => {
  const spec = toSpec(saved);
  assert.deepEqual(spec, { method: "POST", path: "/payments", name: "Create a payment", status: 201, json: { id: "pay_1" }, headers: { Location: "/p/1" } });
  assert.ok(sameInput(toInput(spec), inputOf(saved)));
});

test("fields left out keep the existing values; JSON compares by value", () => {
  const merged = toInput({ method: "POST", path: "/payments", status: 500 }, inputOf(saved));
  assert.equal(merged.responseStatus, 500);
  assert.equal(merged.name, "Create a payment");
  assert.ok(sameInput(toInput({ method: "POST", path: "/payments", json: { id: "pay_1" } }, inputOf(saved)), inputOf(saved)));
  assert.ok(!sameInput(toInput({ method: "POST", path: "/payments", json: { id: "pay_2" } }, inputOf(saved)), inputOf(saved)));
});

test("new endpoints get JSON defaults; LLM kinds have no body", () => {
  const n = toInput({ method: "get", path: "/x" });
  assert.equal(n.method, "GET");
  assert.equal(n.responseStatus, 200);
  assert.deepEqual(n.responseHeaders, { "Content-Type": "application/json" });
  const llm = toInput({ method: "POST", path: "/v1/messages", kind: "anthropic-messages" });
  assert.equal(llm.kind, "ANTHROPIC_MESSAGES");
  assert.deepEqual(llm.llm, {});
  assert.throws(() => toInput({ path: "/x", kind: "smtp" }), /Unknown endpoint kind/);
});

test("argument parsing", () => {
  const { flags, positionals, command } = parseArgs(["create", "POST", "/x", "--status=201", "--header", "A: b", "--header", "C: d", "--no-enabled", "--json", "--", "npm", "test"], {
    status: "string", header: "list", enabled: "bool",
  });
  assert.deepEqual(positionals, ["create", "POST", "/x"]);
  assert.deepEqual(flags, { status: "201", header: ["A: b", "C: d"], enabled: false, json: true });
  assert.deepEqual(command, ["npm", "test"]);
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["--project"]), /needs a value/);
});
