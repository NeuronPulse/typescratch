import { test } from "vitest";
import assert from "node:assert/strict";
import { compareGolden, GOLDEN_ARTIFACTS, GOLDEN_CASES } from "./golden.ts";
import { ROOT } from "./helpers.ts";

test("HIR, backend plan, graph, extension JS and build report match their goldens", () => {
  assert.equal(GOLDEN_ARTIFACTS.length, 5);
  assert.deepEqual(compareGolden(ROOT), []);
});

test("golden cases cover both targets", () => {
  assert.deepEqual(new Set(GOLDEN_CASES.map((item) => item.target)), new Set(["scratch", "turbowarp"]));
});
