import { test } from "vitest";
import assert from "node:assert/strict";
import { compile, NUMERIC_PROFILE } from "@typescratch/compiler";
import { NUMERIC_FIXTURES, runNumericProfile } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

function diagnosticsFor(name: string): string[] {
  const result = compile({ entry: example(name), projectRoot: ROOT, target: "scratch" });
  return result.report.diagnostics.map((item) => item.code);
}

test("numeric profile fixtures model both JavaScript and Scratch semantics", () => {
  const report = runNumericProfile();
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.fixtures, NUMERIC_FIXTURES.length);
  assert.ok(report.differences.length >= 8, "the profile must document real semantic differences");
  assert.ok(report.differences.some((item) => item.label.includes("remainder")));
  assert.ok(report.differences.some((item) => item.label.includes("equality")));
});

test("build reports declare the numeric profile as part of compatibility", () => {
  const result = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  assert.equal(result.report.numericProfile.model, "scratch");
  assert.deepEqual(result.report.numericProfile, NUMERIC_PROFILE);
  assert.ok(result.report.numericProfile.documentedDifferences.length >= 4);
});

test("NaN, Infinity and negative remainder are rejected with TSCR4005", () => {
  const codes = diagnosticsFor("numeric-profile");
  assert.ok(codes.filter((code) => code === "TSCR4005").length >= 2);
});

test("boolean Scratch variables are rejected with TSCR4003", () => {
  assert.ok(diagnosticsFor("boolean-var").includes("TSCR4003"));
});

test("temporaries read across a yielding call are rejected with TSCR4002", () => {
  assert.ok(diagnosticsFor("yield-temp").includes("TSCR4002"));
});

test("temporaries are partitioned per hat script", () => {
  const result = compile({ entry: example("two-hats"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const module = result.modules[0]!;
  assert.equal(module.scripts.length, 2);
  const temps = module.vars.filter((decl) => decl.storage === "temp");
  assert.equal(temps.length, 2);
  assert.deepEqual(new Set(temps.map((decl) => decl.name)).size, 2);
  assert.deepEqual(temps.map((decl) => decl.script).sort(), [0, 1]);
  assert.ok(temps.every((decl) => decl.type === "number"));
  assert.ok(temps.every((decl) => decl.name.startsWith("_tscr_s")));
  assert.equal(result.report.diagnostics.filter((item) => item.code === "TSCR4004").length, 0);
});
