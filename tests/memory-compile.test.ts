import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { createStepSession, interpretModules } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

interface BlockJson {
  opcode: string;
  mutation?: { proccode?: string };
}

interface TargetJson {
  isStage: boolean;
  lists: Record<string, [string, unknown[]]>;
  blocks: Record<string, BlockJson>;
}

function build(entry: string) {
  return compile({ entry: example(entry), projectRoot: ROOT, target: "scratch" });
}

function projectOf(result: ReturnType<typeof build>): { targets: TargetJson[] } {
  return JSON.parse(result.report.projectJson!) as { targets: TargetJson[] };
}

test("objects, fields and arrays lower to heap operations", () => {
  const result = build("memory-object");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const module = result.modules[0]!;
  assert.equal(module.classes?.length, 1);
  assert.deepEqual(module.classes![0]!.fields.map((field) => field.name), ["x", "score", "label"]);
  assert.equal(module.functions?.length, 2);
  assert.deepEqual(
    interpretModules(result.modules).says,
    ["1", "P", "10", "15", "4", "4", "42", "7", "3"],
  );
});

test("heap lists live on the Stage and keep one slot per object", async () => {
  const result = build("memory-object");
  assert.ok(result.sb3);
  const stage = projectOf(result).targets.find((target) => target.isStage)!;
  const listNames = Object.values(stage.lists).map(([name]) => name);
  for (const name of ["heap.classId", "heap.field.x", "heap.field.label", "heap.array.items"]) {
    assert.ok(listNames.includes(name), `missing Stage list ${name}`);
  }
  const session = await createStepSession(result.sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 200 && session.activeThreads() > 0; step++) session.step();
    assert.deepEqual(session.lists()["Stage:heap.classId"], ["Player", "Array"]);
    assert.deepEqual(session.lists()["Stage:heap.field.score"], [15, "0"]);
    assert.deepEqual(session.lists()["Stage:heap.field.x"], [4, "0"]);
    assert.deepEqual(session.lists()["Stage:heap.field.label"], ["P", ""]);
    assert.deepEqual(session.lists()["Stage:heap.array.items"], ["42", "0", "7"]);
  } finally {
    session.close();
  }
});

test("same-named methods get distinct proccodes and dispatch by classId", async () => {
  const result = build("memory-classes");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const graph = projectOf(result);
  const proccodes = new Set<string>();
  for (const target of graph.targets) {
    for (const block of Object.values(target.blocks)) {
      if (block.opcode === "procedures_prototype" && block.mutation?.proccode) {
        proccodes.add(block.mutation.proccode);
      }
    }
  }
  assert.deepEqual([...proccodes].sort(), ["Enemy.step %s %s %s", "Player.step %s %s %s"]);
  const expected = ["1", "100", "player", "enemy", "3", "98", "3", "98"];
  assert.deepEqual(interpretModules(result.modules).says, expected);
  assert.ok(result.sb3);
  const session = await createStepSession(result.sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 200 && session.activeThreads() > 0; step++) session.step();
    assert.deepEqual([...session.says], expected);
  } finally {
    session.close();
  }
});

test("the plan records one dispatch operation per call site", () => {
  const result = build("memory-classes");
  const dispatches = result.report.plan.filter((entry) => entry.operation.startsWith("dispatch:"));
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches.every((entry) => entry.detail.includes("2 method(s)")));
  assert.ok(dispatches.every((entry) => entry.strategy === "native"));
});
