import { test } from "vitest";
import assert from "node:assert/strict";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder, type BlockId } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";
import {
  declareFrameLayout,
  declareFrameToken,
  emitFrameAllocate,
  emitFrameRelease,
  emitFrameReturnRead,
  emitFrameReturnWrite,
  emitFrameSlotAppend,
} from "@typescratch/backend-native";

function frameProject(): Uint8Array {
  const bag = new DiagnosticBag();
  const builder = new GraphBuilder();
  const layout = declareFrameLayout(builder);
  const scripts = [
    { opcode: "event_whenflagclicked", label: "A" },
    {
      opcode: "event_whenkeypressed",
      label: "B",
      fields: { KEY_OPTION: ["space", null] as [string, string | null] },
    },
  ];

  scripts.forEach((script, index) => {
    const scope = `frame-blocks/${index}`;
    const hat = builder.add(script.opcode, {
      scope,
      topLevel: true,
      x: 0,
      y: index * 300,
      fields: "fields" in script ? script.fields : undefined,
    });
    const token = declareFrameToken(builder, index);
    const chain: BlockId[] = [hat];
    chain.push(...emitFrameAllocate(builder, scope, layout, token));
    chain.push(...emitFrameSlotAppend(builder, scope, layout, token));
    chain.push(...emitFrameReturnWrite(builder, scope, layout, token, {
      primitive: [10, script.label],
    }));
    const read = emitFrameReturnRead(builder, scope, layout, token);
    const say = builder.add("looks_say", { scope });
    builder.input(say, "MESSAGE", { block: read });
    chain.push(say);
    chain.push(...emitFrameRelease(builder, scope, layout, token));
    builder.chain(chain);
  });

  assert.equal(bag.items.length, 0, JSON.stringify(bag.items));
  return exportSb3(builder.project, bag);
}

test("concurrent frame allocations keep their return slots isolated in the real VM", async () => {
  const session = await createStepSession(frameProject());
  try {
    session.greenFlag();
    session.startHat("event_whenkeypressed", { KEY_OPTION: "space" });
    assert.equal(session.activeThreads(), 2);
    for (let step = 0; step < 60 && session.activeThreads() > 0; step++) session.step();

    assert.deepEqual([...session.says].sort(), ["A", "B"]);
    assert.equal(session.variables()["Stage:abi.nextFrameId"], 1);
    assert.deepEqual(session.lists()["Stage:abi.freeFrames"], [0]);
    assert.equal(session.lists()["Stage:abi.frame.returnValue"]?.length, 1);
    assert.deepEqual(session.lists()["Stage:abi.frame.returnValue"], ["B"]);
    assert.deepEqual(session.lists()["Stage:abi.frame.status"], ["completed"]);
  } finally {
    session.close();
  }
});
