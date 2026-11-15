import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { recordTrace } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

function sb3(): Uint8Array {
  const result = compile({ entry: example("heap-non-lifo"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  return result.sb3;
}

test("non-LIFO release reuses intervals and clears stale values", async () => {
  const trace = await recordTrace(sb3());
  assert.deepEqual(trace.says, ["reused 0"]);
  assert.deepEqual(trace.final.lists["Sprite1:non-lifo results"], [
    "before=42,99",
    "cleared=0,0",
  ]);
  assert.equal(trace.final.lists["Stage:heap.array.items"]?.length, 5);
});

test("three green flags keep every heap list stable after non-LIFO release", async () => {
  const trace = await recordTrace(sb3(), { greenFlags: 3 });
  assert.equal(trace.roundFinals.length, 3);
  assert.deepEqual(
    trace.roundFinals.map((final) => final.lists["Stage:heap.array.items"]?.length ?? 0),
    [5, 5, 5],
  );
  assert.deepEqual(
    trace.roundFinals.map((final) => final.lists["Stage:heap.classId"]?.length ?? 0),
    [2, 2, 2],
  );
  assert.deepEqual(
    trace.roundFinals.map((final) => final.lists["Stage:heap.array.freeStart"]?.length ?? 0),
    [2, 2, 2],
  );
  assert.deepEqual(trace.says, ["reused 0", "reused 0", "reused 0"]);
});
