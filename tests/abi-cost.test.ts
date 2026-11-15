import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { collectAbiOperations } from "@typescratch/backend-planner";
import {
  ABI_CONTRACTS,
  ABI_OPERATION_COSTS,
  capabilitiesFor,
  chooseProfile,
  mergeAbiRegions,
  regionSummary,
  type AbiOperation,
  type AbiOperationKind,
} from "@typescratch/runtime-abi";
import { example, ROOT } from "./helpers.ts";

function operation(kind: AbiOperationKind, sequence: number, scope: string): AbiOperation {
  const spec = ABI_OPERATION_COSTS[kind];
  return { kind, contract: spec.contract, cost: spec.cost, sequence, scope };
}

test("every ABI operation kind has a positive cost and a declared contract", () => {
  for (const [kind, spec] of Object.entries(ABI_OPERATION_COSTS)) {
    assert.equal(spec.kind, kind);
    assert.ok(spec.cost > 0);
    assert.ok(ABI_CONTRACTS.includes(spec.contract));
  }
});

test("region merging collapses only consecutive operations in the same scope", () => {
  const operations = [
    operation("heap.allocate", 0, "Sprite1:0"),
    operation("heap.field.write", 1, "Sprite1:0"),
    operation("heap.field.read", 2, "Sprite1:0"),
    operation("heap.allocate", 3, "Sprite1:1"),
    operation("heap.free", 7, "Sprite1:0"),
  ];
  const regions = mergeAbiRegions(operations);
  assert.equal(regions.length, 3);
  assert.deepEqual(
    regions[0]!.operations.map((item) => item.kind),
    ["heap.allocate", "heap.field.write", "heap.field.read"],
  );
  assert.equal(regions[0]!.cost, 4 + 2 + 2);
  assert.deepEqual(regionSummary(regions), {
    operations: 5,
    regions: 3,
    boundaryCalls: 3,
    cost: 4 + 2 + 2 + 4 + 3,
  });
});

test("chooseProfile honours explicit requests and never picks an unimplemented runtime", () => {
  assert.deepEqual(chooseProfile("native", "turbowarp", ["memory"]), {
    profile: "native",
    reason: "explicit --abi-profile native",
  });
  assert.equal(chooseProfile("auto", "scratch", ["memory"]).profile, "native");
  assert.equal(chooseProfile("auto", "turbowarp", []).profile, "native");
  assert.equal(chooseProfile("auto", "turbowarp", ["memory"]).profile, "native");
  assert.match(chooseProfile("auto", "turbowarp", ["memory"]).reason, /cheapest capable/);
  assert.equal(capabilitiesFor("extension").length, 0);
});

test("the planner charges operations and records region cost in the report", () => {
  const result = compile({ entry: example("showcase"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const operations = collectAbiOperations(result.modules);
  const summary = result.report.abiRegions;
  assert.equal(summary.operations, operations.length);
  assert.ok(summary.regions > 0);
  assert.ok(summary.regions < summary.operations);
  assert.equal(summary.boundaryCalls, summary.regions);
  assert.equal(summary.cost, operations.reduce((total, item) => total + item.cost, 0));
  assert.deepEqual(result.report.compatibility.requiredContracts, result.report.abiContracts.required);
  assert.ok(result.report.compatibility.notes.some((note) => note.includes("ABI profile:")));
  assert.match(result.report.abiProfile.reason, /cheapest capable profile/);
});

test("a static-only project has zero ABI cost and no required contracts", () => {
  const result = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(result.report.abiRegions, {
    operations: 0, regions: 0, boundaryCalls: 0, cost: 0,
  });
  assert.deepEqual(result.report.compatibility.requiredContracts, []);
  assert.equal(result.report.abiProfile.resolved, result.report.abiProfile.lowering);
});
