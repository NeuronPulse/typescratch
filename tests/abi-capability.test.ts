import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { collectAbiUsage, planBackends } from "@typescratch/backend-planner";
import { DiagnosticBag } from "@typescratch/diagnostics";
import type { Module } from "@typescratch/ir";
import {
  ABI_CONTRACTS,
  NO_ABI_USAGE,
  capabilitiesFor,
  mergeUsage,
  requiredContracts,
  unsupportedContracts,
} from "@typescratch/runtime-abi";
import { example, ROOT } from "./helpers.ts";

function build(entry: string) {
  return compile({ entry: example(entry), projectRoot: ROOT, target: "scratch" });
}

test("the capability table implements §2 subsets", () => {
  assert.deepEqual(capabilitiesFor("native"), ABI_CONTRACTS);
  assert.deepEqual(capabilitiesFor("extension"), []);
  assert.deepEqual(requiredContracts(NO_ABI_USAGE), []);
  assert.deepEqual(requiredContracts({ ...NO_ABI_USAGE, memory: true }), ["memory"]);
  assert.deepEqual(
    unsupportedContracts("extension", { ...NO_ABI_USAGE, memory: true, dispatch: true }),
    ["memory", "dispatch"],
  );
  assert.deepEqual(
    unsupportedContracts("native", { ...NO_ABI_USAGE, memory: true }),
    [],
  );
  assert.deepEqual(
    mergeUsage({ ...NO_ABI_USAGE, value: true }, { ...NO_ABI_USAGE, frame: true }),
    { ...NO_ABI_USAGE, value: true, frame: true },
  );
});

test("a static-only project needs no ABI contract", () => {
  const result = build("hello-native");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(result.report.abiContracts, { required: [], unsupported: [] });
});

test("showcase reports the five contracts it actually uses", () => {
  const result = build("showcase");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(result.report.abiContracts, {
    required: ["value", "call", "frame", "memory", "dispatch"],
    unsupported: [],
  });
  const calls = result.report.plan.filter((entry) => entry.operation.startsWith("call:"));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((entry) => entry.contract === "frame"));
  const dispatch = result.report.plan.filter((entry) => entry.operation.startsWith("dispatch:"));
  assert.ok(dispatch.length > 0);
  assert.ok(dispatch.every((entry) => entry.contract === "dispatch"));
});

test("a yielding intrinsic requires the execution contract", () => {
  const module: Module = {
    entry: "fake.ts",
    scripts: [{
      hat: { kind: "flag" },
      body: [{
        k: "expr",
        name: "wait",
        args: [{ k: "const", value: 1, type: "number" }],
      }],
    }],
    vars: [],
    lists: [],
  };
  assert.deepEqual(requiredContracts(collectAbiUsage([module])), ["execution"]);
});

test("unsupported contracts fail at plan time with TSCR4001", () => {
  const result = build("showcase");
  const usage = collectAbiUsage(result.modules);
  assert.deepEqual(requiredContracts(usage), result.report.abiContracts.required);
  const bag = new DiagnosticBag();
  planBackends(result.modules, "scratch", bag, { abiProfile: "extension" });
  const abiErrors = bag.items.filter((item) => item.code === "TSCR4001");
  // Route A declares Call/Value/Frame as Native-backed mixed lowering; only
  // Memory and Dispatch have no Extension implementation and must fail.
  assert.equal(abiErrors.length, 2);
  assert.ok(abiErrors.some((item) => item.message.includes("memory")));
  assert.ok(abiErrors.some((item) => item.message.includes("dispatch")));
});
