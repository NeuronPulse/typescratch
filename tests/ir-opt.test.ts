import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { optimizeModules, type OptimizationStats } from "@typescratch/ir-opt";
import type { Module } from "@typescratch/ir";
import { interpretModules } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

function build(optimize?: boolean) {
  return compile({
    entry: example("ir-opt"),
    projectRoot: ROOT,
    target: "scratch",
    optimize,
  });
}

function assertZero(stats: OptimizationStats): void {
  assert.deepEqual(stats, {
    folded: 0,
    simplified: 0,
    branchesRemoved: 0,
    loopsRemoved: 0,
    controlFlowRewrites: 0,
  });
}

test("ir-opt folds constants, removes dead branches and simplifies guarded expressions", () => {
  const result = build();
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const stats = result.report.optimization;
  assert.ok(stats.folded >= 3, `expected folding, got ${JSON.stringify(stats)}`);
  assert.ok(stats.simplified >= 2, `expected simplification, got ${JSON.stringify(stats)}`);
  assert.ok(stats.branchesRemoved >= 1);
  assert.ok(stats.loopsRemoved >= 1);
});

test("optimized output has fewer blocks and the same observable behaviour", () => {
  const optimized = build();
  const unoptimized = build(false);
  assert.equal(unoptimized.ok, true);
  assertZero(unoptimized.report.optimization);
  assert.ok(optimized.report.blockCount < unoptimized.report.blockCount);
  assert.deepEqual(interpretModules(optimized.modules).says, ["alive", "7", "ab", "4"]);
  assert.deepEqual(interpretModules(unoptimized.modules).says, interpretModules(optimized.modules).says);
});

test("folded arithmetic leaves no native operator blocks", () => {
  const result = build();
  const opcodes = new Set(
    (result.graph?.targets ?? []).flatMap((target) =>
      [...target.blocks.values()].map((block) => block.opcode),
    ),
  );
  assert.equal(opcodes.has("operator_add"), false);
  assert.equal(opcodes.has("operator_multiply"), false);
  assert.equal(opcodes.has("control_repeat_until"), false);
  assert.equal(opcodes.has("control_if_else"), false);
});

test("abstractEq folds literal strings with case-sensitive ECMAScript semantics", () => {
  const cases: [string, string, boolean][] = [
    ["A", "a", false], ["a", "a", true], ["HELLO", "hello", false],
    ["Hello", "Hello", true], ["", "", true], ["AbC", "Abc", false],
    ["123", "123", true], ["a b", "a b", true],
  ];
  for (const [left, right, expected] of cases) {
    const module: Module = {
      entry: "synthetic.ts", vars: [], lists: [],
      scripts: [{ hat: { kind: "flag" }, body: [{
        k: "expr", name: "say", args: [{
          k: "abstractEq", negate: false, type: "boolean",
          l: { k: "const", value: left, type: "string" },
          r: { k: "const", value: right, type: "string" },
        }],
      }] }],
    };
    const result = optimizeModules([module]);
    const stmt = result.modules[0]!.scripts[0]!.body[0]!;
    assert.equal(stmt.k, "expr");
    if (stmt.k !== "expr") continue;
    const folded = stmt.args[0] as { k: string; value?: unknown; type?: string };
    assert.equal(folded.k, "const");
    assert.equal(folded.value, expected);
    assert.equal(folded.type, "boolean");
  }
});

test("comparison and modulo are never folded across the JavaScript/Scratch semantic gap", () => {
  const module: Module = {
    entry: "synthetic.ts",
    vars: [],
    lists: [],
    scripts: [{
      hat: { kind: "flag" },
      body: [{
        k: "expr",
        name: "say",
        args: [{
          k: "binary",
          op: "eq",
          l: { k: "const", value: 10, type: "number" },
          r: { k: "const", value: "10", type: "string" },
          type: "boolean",
        }],
      }],
    }],
  };
  const result = optimizeModules([module]);
  const statement = result.modules[0]!.scripts[0]!.body[0]!;
  assert.ok(statement.k === "expr");
  assert.equal(statement.args[0]?.k, "binary");
  assert.equal(result.stats.folded, 0);
  assertZero(optimizeModules(result.modules).stats);
});
