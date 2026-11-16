import { test } from "vitest";
import assert from "node:assert/strict";
import { FRAME_EXTENSION_OPS, FRAME_EXTENSION_PREAMBLE } from "@typescratch/runtime-abi";
import { ExtensionFrameStore } from "@typescratch/backend-native";

test("frame primitives declare a worker Map and a monotonic callId allocator", () => {
  assert.ok(FRAME_EXTENSION_PREAMBLE.includes("const frames = new Map()"));
  assert.ok(FRAME_EXTENSION_PREAMBLE.includes("nextId"));
  assert.ok(FRAME_EXTENSION_PREAMBLE.includes("freeIds"));
  assert.ok(FRAME_EXTENSION_PREAMBLE.includes("orphanCount"));
  const alloc = FRAME_EXTENSION_OPS["abi.frame.alloc"]!;
  assert.ok(alloc.body!([""]).some((line) => line.includes("frames.set")));
  assert.ok(alloc.body!([""]).some((line) => line.includes("MAX_FRAME_DEPTH")));
});

test("frameFree is a tombstone, not a delete — returnValue survives for the caller", () => {
  const free = FRAME_EXTENSION_OPS["abi.frame.free"]!;
  const body = free.body!(["0"]).join("\n");
  assert.ok(body.includes('status = "completed"'), "free must tombstone like native emitFrameRelease");
  assert.ok(body.includes("freeIds.push(0)"), "free must return the id to the free list");
  assert.ok(!body.includes("frames.delete"), "free must not delete returnValue/returnTag data");
});

test("mixed frame.set signature declares per-argument types", () => {
  const set = FRAME_EXTENSION_OPS["abi.frame.set"]!;
  assert.deepEqual(set.arguments.map((argument) => argument.type), ["NUMBER", "STRING", "STRING"]);
  // A single global Number() guard would turn the slot name into NaN.
  assert.equal(set.guard, "number");
});

test("missing frames throw instead of returning an in-band default", () => {
  const get = FRAME_EXTENSION_OPS["abi.frame.get"]!;
  const set = FRAME_EXTENSION_OPS["abi.frame.set"]!;
  assert.equal(get.throws, true);
  assert.equal(set.throws, true);
  const body = get.body!(["A", "B"]).join("\n");
  assert.ok(body.includes("throw new Error('TSCR_FRAME_MISSING"));
  assert.ok(!/return\s+0|return\s+""|return\s+null/.test(body));
});

test("ExtensionFrameStore reports a distinct strategy from Native", () => {
  const store = new ExtensionFrameStore("tscr0c0570ab01");
  assert.equal(store.strategy, "extension");
  assert.equal(store.declareLayout().lists["abi.frame.returnValue"], undefined);
});
