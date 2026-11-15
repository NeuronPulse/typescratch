import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

interface BlockJson {
  opcode: string;
  inputs: Record<string, unknown>;
  fields: Record<string, [string, unknown]>;
}

function build() {
  return compile({ entry: example("showcase"), projectRoot: ROOT, target: "scratch" });
}

test("heapFree survives every IR walker and reaches the block graph", () => {
  const result = build();
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const hir = result.report.hirDump ?? "";
  assert.equal((hir.match(/heapFree/g) ?? []).length, 2);

  const graph = JSON.parse(result.report.projectJson!) as {
    targets: { blocks: Record<string, BlockJson> }[];
  };
  const blocks = graph.targets.flatMap((target) => Object.values(target.blocks));
  const arrayDeletes = blocks.filter((block) =>
    block.opcode === "data_deleteoflist" && block.fields.LIST?.[0] === "heap.array.items");
  assert.equal(arrayDeletes.length, 3, "one delete per compile-time array slot");
  assert.ok(arrayDeletes.every((block) => JSON.stringify(block.inputs.INDEX).includes("last")));
});

test("released ids are reused and released slots become tombstones", async () => {
  const result = build();
  assert.ok(result.sb3);
  const session = await createStepSession(result.sb3);
  try {
    for (let round = 0; round < 2; round++) {
      session.greenFlag();
      for (let step = 0; step < 200 && session.activeThreads() > 0; step++) session.step();
      const lists = session.lists();
      assert.deepEqual(lists["Stage:heap.classId"], ["Counter", "Array"]);
      assert.deepEqual(lists["Stage:heap.status"], ["released", "released"]);
      assert.equal(lists["Stage:heap.freeObjects"]?.length, 2);
      assert.equal(lists["Stage:heap.array.items"]?.length, 0);
    }
  } finally {
    session.close();
  }
});
