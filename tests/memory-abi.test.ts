import { test } from "vitest";
import assert from "node:assert/strict";
import {
  ARRAY_CLASS,
  HEAP_ARRAY_ITEMS,
  HEAP_CLASS_LIST,
  INITIAL_HEAP_ALLOCATOR,
  INITIAL_HEAP_TABLE,
  MAX_OBJECTS,
  NULL_OBJECT,
  allocateObjectId,
  dispatchCost,
  dispatchTargets,
  heapAllListNames,
  heapArrayLength,
  heapClassOf,
  heapFieldList,
  heapNew,
  heapParallelLists,
  heapReadArray,
  heapReadField,
  heapRelease,
  heapWriteArray,
  heapWriteField,
  isDispatchExhaustive,
  objectStrictEquals,
  releaseObjectId,
} from "@typescratch/runtime-abi";

test("heap layout is one parallel list per field plus array metadata", () => {
  assert.deepEqual(heapParallelLists(["x", "score"]), [
    HEAP_CLASS_LIST,
    "heap.status",
    "heap.array.start",
    "heap.array.length",
    heapFieldList("x"),
    heapFieldList("score"),
  ]);
  assert.ok(heapAllListNames(["x"]).includes(HEAP_ARRAY_ITEMS));
  assert.ok(heapAllListNames(["x"]).includes("heap.freeObjects"));
});

test("free-list allocation reuses ids instead of growing the heap", () => {
  const first = allocateObjectId(INITIAL_HEAP_ALLOCATOR);
  const second = allocateObjectId(first.state);
  assert.deepEqual([first.id, second.id], [0, 1]);
  assert.equal(second.state.nextObjectId, 2);
  const released = releaseObjectId(second.state, first.id);
  const reused = allocateObjectId(released);
  assert.equal(reused.id, 0);
  assert.equal(reused.state.nextObjectId, 2);
  assert.throws(() => releaseObjectId(released, first.id), /released twice/);
});

test("object fields are isolated and class identity is stored by ref", () => {
  const a = heapNew(INITIAL_HEAP_TABLE, "Player", new Map([["x", 7]]));
  const b = heapNew(a.state, "Enemy", new Map([["x", 99]]));
  assert.notEqual(a.ref, b.ref);
  assert.equal(heapClassOf(b.state, a.ref), "Player");
  assert.equal(heapClassOf(b.state, b.ref), "Enemy");
  assert.equal(heapReadField(b.state, a.ref, "x"), 7);
  const updated = heapWriteField(b.state, a.ref, "x", 12);
  assert.equal(heapReadField(updated, a.ref, "x"), 12);
  assert.equal(heapReadField(updated, b.ref, "x"), 99);
  assert.equal(heapReadField(b.state, a.ref, "x"), 7, "heap tables are immutable");
});

test("arrays own disjoint item ranges and never clobber each other", () => {
  const first = heapNew(INITIAL_HEAP_TABLE, ARRAY_CLASS, new Map(), 3);
  const second = heapNew(first.state, ARRAY_CLASS, new Map(), 2);
  let state = heapWriteArray(second.state, first.ref, 0, 42);
  state = heapWriteArray(state, first.ref, 2, 17);
  state = heapWriteArray(state, second.ref, 0, 5);
  assert.equal(heapArrayLength(state, first.ref), 3);
  assert.equal(heapArrayLength(state, second.ref), 2);
  assert.equal(heapReadArray(state, first.ref, 0), 42);
  assert.equal(heapReadArray(state, first.ref, 2), 17);
  assert.equal(heapReadArray(state, second.ref, 0), 5);
  assert.equal(heapReadArray(state, first.ref, 1), 0);
});

test("out-of-range array access is inert and released refs are rejected", () => {
  const created = heapNew(INITIAL_HEAP_TABLE, ARRAY_CLASS, new Map(), 2);
  assert.equal(heapReadArray(created.state, created.ref, 2), "");
  assert.equal(heapWriteArray(created.state, created.ref, -1, 9).items.length, 2);
  const released = heapRelease(created.state, created.ref);
  assert.throws(() => heapReadField(released, created.ref, "x"), /released/);
  const reused = heapNew(released, ARRAY_CLASS, new Map(), 1);
  assert.equal(reused.ref, created.ref);
  assert.equal(heapArrayLength(reused.state, reused.ref), 1);
});

test("non-LIFO releases register both intervals and reuse does not append", () => {
  const first = heapNew(INITIAL_HEAP_TABLE, ARRAY_CLASS, new Map(), 3);
  const second = heapNew(first.state, ARRAY_CLASS, new Map(), 2);
  let state = heapWriteArray(second.state, first.ref, 0, 42);
  state = heapRelease(state, first.ref);
  state = heapRelease(state, second.ref);
  assert.deepEqual(state.freeIntervals, [
    { start: 0, length: 3 },
    { start: 3, length: 2 },
  ]);
  assert.equal(state.items.length, 5);
  const reused = heapNew(state, ARRAY_CLASS, new Map(), 2);
  assert.equal(heapArrayLength(reused.state, reused.ref), 2);
  assert.equal(reused.state.items.length, 5);
  assert.equal(heapReadArray(reused.state, reused.ref, 0), 0, "reused slots are cleared");
});

test("a larger free interval is split and the remainder is reused", () => {
  const big = heapNew(INITIAL_HEAP_TABLE, ARRAY_CLASS, new Map(), 5);
  const written = heapWriteArray(big.state, big.ref, 0, 42);
  const freed = heapRelease(written, big.ref);
  const small = heapNew(freed, ARRAY_CLASS, new Map(), 2);
  assert.deepEqual(small.state.freeIntervals, [{ start: 2, length: 3 }]);
  assert.equal(small.state.items.length, 5);
  assert.equal(heapReadArray(small.state, small.ref, 0), 0);
  const rest = heapNew(small.state, ARRAY_CLASS, new Map(), 3);
  assert.equal(rest.state.items.length, 5);
  assert.deepEqual(rest.state.freeIntervals, []);
});

test("the heap allocator refuses the scratch-vm list limit explicitly", () => {
  const nearLimit = allocateObjectId({ nextObjectId: MAX_OBJECTS - 1, freeObjects: [] });
  assert.equal(nearLimit.id, MAX_OBJECTS - 1);
  assert.throws(
    () => allocateObjectId(nearLimit.state),
    new RegExp(`heap object limit ${MAX_OBJECTS}`),
  );
  assert.throws(
    () => heapNew(
      { ...INITIAL_HEAP_TABLE, items: Array.from({ length: MAX_OBJECTS }, () => 0) },
      ARRAY_CLASS,
      new Map(),
      1,
    ),
    /heap array item limit/,
  );
});

test("ObjectRef identity uses the ref, not field contents", () => {
  assert.equal(objectStrictEquals(3, 3), true);
  assert.equal(objectStrictEquals(3, 4), false);
  assert.equal(objectStrictEquals(NULL_OBJECT, NULL_OBJECT), false);
});

test("dispatch collects one target per implementing class and is costed once", () => {
  const classes = [
    { id: "Player", methods: ["move", "label"] },
    { id: "Enemy", methods: ["move"] },
  ];
  const targets = dispatchTargets(classes, "move", (classId, method) => `fn_${classId}_${method}`);
  assert.deepEqual(targets, [
    { classId: "Player", function: "fn_Player_move" },
    { classId: "Enemy", function: "fn_Enemy_move" },
  ]);
  assert.equal(dispatchCost(targets), 3);
  assert.equal(isDispatchExhaustive(targets, classes, "move"), true);
  assert.deepEqual(dispatchTargets(classes, "missing", (classId) => classId), []);
  assert.equal(dispatchCost([]), 0);
});
