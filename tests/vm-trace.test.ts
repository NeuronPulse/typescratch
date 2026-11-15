import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { formatTrace, isCompilerState, recordTrace } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

function sb3Of(entry: string): Uint8Array {
  const result = compile({ entry: example(entry), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  return result.sb3;
}

function resultsOf(final: { lists: Record<string, unknown[]> }): unknown[] {
  return final.lists["Sprite1:showcase results"] ?? final.lists["Stage:showcase results"] ?? [];
}

const EXPECTED_RESULTS = [
  "loop 1", "loop 3", "label=counter", "counter=7", "factorial=120", "array=7,6,3",
];

test("recordTrace captures says and list changes across frames", async () => {
  const trace = await recordTrace(sb3Of("showcase"));
  assert.deepEqual(trace.says, ["C=7 F=120 A=7,6,3"]);
  assert.deepEqual(resultsOf(trace.final), EXPECTED_RESULTS);
  assert.equal(trace.roundFinals.length, 1);
  assert.ok(trace.frames.some((frame) => frame.says.length > 0));
  assert.ok(trace.frames.some((frame) => Object.keys(frame.lists).length > 0));
  assert.match(formatTrace(trace), /SAY "C=7 F=120 A=7,6,3"/);
});

test("internal compiler state is filtered from frame diffs but kept in round finals", async () => {
  const trace = await recordTrace(sb3Of("showcase"));
  for (const frame of trace.frames) {
    for (const key of Object.keys(frame.variables)) assert.equal(isCompilerState(key), false);
    for (const key of Object.keys(frame.lists)) assert.equal(isCompilerState(key), false);
  }
  assert.deepEqual(trace.roundFinals[0]!.lists["Stage:heap.classId"], ["Counter", "Array"]);

  const withInternal = await recordTrace(sb3Of("showcase"), { includeCompilerState: true });
  assert.ok(withInternal.frames.some((frame) =>
    Object.keys(frame.variables).some((key) => isCompilerState(key))));
});

test("repeated green flags keep the results list and every heap list stable", async () => {
  const trace = await recordTrace(sb3Of("showcase"), { greenFlags: 3 });
  assert.equal(trace.roundFinals.length, 3);
  for (const final of trace.roundFinals) assert.deepEqual(resultsOf(final), EXPECTED_RESULTS);
  assert.deepEqual(
    trace.roundFinals.map((final) => final.lists["Stage:heap.classId"]?.length ?? 0),
    [2, 2, 2],
  );
  assert.deepEqual(
    trace.roundFinals.map((final) => final.lists["Stage:heap.array.items"]?.length ?? 0),
    [0, 0, 0],
  );
  assert.deepEqual(
    trace.roundFinals.map((final) => final.lists["Stage:heap.freeObjects"]?.length ?? 0),
    [2, 2, 2],
  );
  assert.deepEqual(trace.says, [
    "C=7 F=120 A=7,6,3", "C=7 F=120 A=7,6,3", "C=7 F=120 A=7,6,3",
  ]);
});
