import { test } from "vitest";
import assert from "node:assert/strict";
import {
  allocateFrameId,
  FRAME_LIST_NAMES,
  frameListNames,
  frameLocalList,
  frameTempList,
  INITIAL_FRAME_TABLE,
  MAX_FRAME_DEPTH,
  popFrame,
  pushFrame,
  readFrame,
  writeFrame,
  type FrameRecord,
} from "@typescratch/runtime-abi";

function record(functionId: number, parent: number | null): FrameRecord {
  return {
    functionId,
    parent,
    returnAddress: `call:${functionId}`,
    returnTag: "",
    returnValue: "",
    status: "running",
    locals: [],
    temps: [],
  };
}

test("interleaved invocations keep independent slots and free ids are recycled", () => {
  const first = pushFrame(INITIAL_FRAME_TABLE, record(10, null));
  const second = pushFrame(first.state, record(20, null));
  assert.equal(first.id, 0);
  assert.equal(second.id, 1);

  const afterFirstPop = popFrame(second.state, first.id);
  assert.equal(readFrame(afterFirstPop, first.id), undefined);
  assert.equal(readFrame(afterFirstPop, second.id)?.functionId, 20);

  const third = pushFrame(afterFirstPop, record(30, null));
  assert.equal(third.id, first.id);
  assert.equal(readFrame(third.state, second.id)?.functionId, 20);
});

test("nested calls form a parent chain", () => {
  const outer = pushFrame(INITIAL_FRAME_TABLE, record(1, null));
  const inner = pushFrame(outer.state, record(2, outer.id));
  assert.equal(readFrame(inner.state, inner.id)?.parent, outer.id);
  const done = writeFrame(inner.state, inner.id, { status: "returning", returnTag: "n", returnValue: 42 });
  assert.equal(readFrame(done, inner.id)?.returnValue, 42);
  assert.equal(readFrame(done, outer.id)?.status, "running");
});

test("frame list layout covers fixed lists, the free list, locals and temps", () => {
  const names = frameListNames(2, 3);
  assert.equal(names.length, FRAME_LIST_NAMES.length + 1 + 2 + 3);
  for (const name of FRAME_LIST_NAMES) assert.ok(names.includes(name));
  assert.ok(names.includes("abi.freeFrames"));
  assert.ok(names.includes(frameLocalList(0)) && names.includes(frameLocalList(1)));
  assert.ok(names.includes(frameTempList(2)));
  assert.equal(new Set(names).size, names.length);
});

test("allocation refuses to exceed the VM list limit", () => {
  assert.throws(
    () => allocateFrameId({ nextFrameId: MAX_FRAME_DEPTH, freeFrames: [] }),
    /frame depth limit/,
  );
});

test("double release and unknown frames are rejected", () => {
  const first = pushFrame(INITIAL_FRAME_TABLE, record(1, null));
  const popped = popFrame(first.state, first.id);
  assert.throws(() => popFrame(popped, first.id), /unknown frame/);
  assert.throws(() => writeFrame(popped, first.id, { status: "completed" }), /unknown frame/);
});
