import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { example, ROOT } from "./helpers.ts";

test("Math.hypot is rejected on the scratch target", () => {
  const result = compile({ entry: example("extension-needed"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, false);
  const diagnostic = result.report.diagnostics.find((item) => item.code === "TSCR5001");
  assert.ok(diagnostic);
  assert.ok(diagnostic.details?.some((detail) => detail.includes("TurboWarp")));
  assert.equal(result.sb3, undefined);
  assert.equal(result.outputs.length, 0);
});

test("turbowarp target lowers Math.hypot to a generated extension", () => {
  const result = compile({ entry: example("extension-needed"), projectRoot: ROOT, target: "turbowarp" });
  assert.equal(result.ok, true);
  assert.equal(result.report.compatibility.officialScratch, false);
  assert.equal(result.report.compatibility.customExtensions, 1);
  assert.ok(result.bundle);
  assert.ok(result.outputs.some((file) => file.filename.endsWith(".js")));
  assert.ok(result.outputs.some((file) => file.filename.endsWith(".turbowarp.json")));
});

test("native-only programs remain Scratch compatible on the turbowarp target", () => {
  const result = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "turbowarp" });
  assert.equal(result.ok, true);
  assert.equal(result.report.compatibility.officialScratch, true);
  assert.equal(result.report.compatibility.customExtensions, 0);
  assert.equal(result.bundle, undefined);
});
