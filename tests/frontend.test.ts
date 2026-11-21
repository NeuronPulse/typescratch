import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { example, ROOT } from "./helpers.ts";

test("API recognition is symbol based, not name based", () => {
  const result = compile({ entry: example("alias"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  const body = result.modules[0]?.scripts[0]?.body[0];
  assert.ok(body && body.k === "expr");
  assert.equal(body.name, "say");
  assert.deepEqual(body.args[0], {
    k: "const",
    value: "alias works",
    type: "string",
    span: (body.args[0] as { span?: unknown }).span,
  });
});

test("compile-time constants are inlined and do not become Scratch variables", () => {
  const result = compile({ entry: example("constant"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  assert.equal(result.modules[0]?.vars.length, 0);
  const body = result.modules[0]?.scripts[0]?.body[0];
  assert.ok(body && body.k === "expr" && body.args[0]?.k === "const");
  assert.equal(body.args[0].value, "compile-time value");
});

test("logical operators lower to operator_and/or (both operands evaluated)", () => {
  const result = compile({ entry: example("logical"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  const body = result.modules[0]?.scripts[0]?.body ?? [];
  assert.ok(body.some((stmt) => stmt.k === "if"));
  const opcodes = new Set(
    [...(result.graph?.targets[1]?.blocks.values() ?? [])].map((block) => block.opcode),
  );
  // A statement prelude would snapshot the value before a `while` condition
  // and spin forever; Scratch's operator re-evaluates each iteration. The
  // trade-off is that JS short-circuiting is intentionally not preserved.
  assert.ok(opcodes.has("operator_and") || opcodes.has("operator_or"));
});

test("TypeScript diagnostics are surfaced as TSCR1001", () => {
  const result = compile({ entry: example("type-error"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((item) => item.code === "TSCR1001"));
});

test("unsupported syntax is rejected with TSCR2001", () => {
  const result = compile({ entry: example("unsupported"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((item) => item.code === "TSCR2001"));
});
