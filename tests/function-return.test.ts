import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { createStepSession, interpretModules } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

function build(entry: string) {
  return compile({ entry: example(entry), projectRoot: ROOT, target: "scratch" });
}

async function runVm(sb3: Uint8Array, key?: string): Promise<string[]> {
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    if (key) session.startHat("event_whenkeypressed", { KEY_OPTION: key });
    for (let step = 0; step < 80 && session.activeThreads() > 0; step++) session.step();
    return [...session.says].sort();
  } finally {
    session.close();
  }
}

test("a user function lowers to a call frame and returns a value", () => {
  const result = build("function-return");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.equal(result.modules[0]!.functions?.length, 1);
  assert.deepEqual(interpretModules(result.modules).says, ["42"]);
});

test("the generated custom procedure returns 42 in headless scratch-vm", async () => {
  const result = build("function-return");
  assert.ok(result.sb3);
  assert.deepEqual(await runVm(result.sb3), ["42"]);
  const session = await createStepSession(result.sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 60 && session.activeThreads() > 0; step++) session.step();
    assert.equal(session.variables()["Stage:abi.nextFrameId"], 1);
    assert.deepEqual(session.lists()["Stage:abi.frame.returnValue"], [42]);
    assert.deepEqual(session.lists()["Stage:abi.frame.returnTag"], ["n"]);
    const tagValues = Object.entries(session.variables())
      .filter(([key]) => key.includes("call1_tag"))
      .map(([, value]) => value);
    assert.deepEqual(tagValues, ["n"]);
  } finally {
    session.close();
  }
});

test("nested calls and early return keep their own frames", async () => {
  const result = build("function-nested");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.equal(result.modules[0]!.functions?.length, 2);
  assert.deepEqual(interpretModules(result.modules).says, ["1", "8"]);
  assert.ok(result.sb3);
  assert.deepEqual(await runVm(result.sb3), ["1", "8"]);
});

test("two event threads calling the same function stay isolated", async () => {
  const result = build("function-reentrant");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  assert.deepEqual(await runVm(result.sb3, "space"), ["10", "14"]);
});

test("boolean parameters use the boolean argument reporter", async () => {
  const result = build("function-boolean");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["1", "0"]);
  assert.ok(result.sb3);
  assert.deepEqual(await runVm(result.sb3), ["0", "1"]);
});

test("the build report records the configured ABI profile for each call", () => {
  const native = build("function-return");
  assert.equal(native.ok, true, JSON.stringify(native.report.diagnostics));
  const nativeCalls = native.report.plan.filter((entry) => entry.operation.startsWith("call:"));
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0]!.abiProfile, "native");
  assert.equal(nativeCalls[0]!.strategy, "native");

  const extension = compile({
    entry: example("function-return"), projectRoot: ROOT, target: "turbowarp",
  });
  assert.equal(extension.ok, true, JSON.stringify(extension.report.diagnostics));
  const extensionCalls = extension.report.plan.filter((entry) => entry.operation.startsWith("call:"));
  assert.equal(extensionCalls[0]!.abiProfile, "extension");
  assert.equal(extensionCalls[0]!.strategy, "native");
});

test("recursion is rejected with TSCR3002", () => {
  const result = build("function-recursion");
  assert.equal(result.ok, false);
  assert.ok(
    result.report.diagnostics.some((item) => item.code === "TSCR3002"),
    JSON.stringify(result.report.diagnostics),
  );
});
