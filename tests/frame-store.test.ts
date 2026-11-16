import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { nativeFrameStore } from "@typescratch/backend-native";
import { example, ROOT } from "./helpers.ts";

test("native FrameStore is the reference strategy and keeps call frames intact", () => {
  assert.equal(nativeFrameStore.strategy, "native");
  const result = compile({
    entry: example("function-return"), projectRoot: ROOT, target: "scratch",
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const frameOps = result.report.plan.filter((entry) => entry.contract === "frame");
  assert.ok(frameOps.length > 0, "expected frame plan entries");
  assert.ok(frameOps.every((entry) => entry.strategy === "native"));
  assert.ok(frameOps.every((entry) => entry.abiProfile !== "extension"));
});
