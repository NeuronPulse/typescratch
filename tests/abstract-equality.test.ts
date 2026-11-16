import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { interpretModules } from "@typescratch/testing";
import {
  abstractEquals,
  objectRef,
  runValueConformance,
  tag,
} from "@typescratch/runtime-abi";
import { example, ROOT } from "./helpers.ts";

test("the abstract equality matrix matches JavaScript ==", () => {
  const report = runValueConformance();
  assert.equal(report.abstractPairs, 16 ** 2);
  assert.deepEqual(report.mismatches, []);
});

test("contract covers the boundaries Scratch Cast cannot express", () => {
  assert.equal(abstractEquals(tag("1"), tag(1)), true);
  assert.equal(abstractEquals(tag("01"), tag(1)), true);
  assert.equal(abstractEquals(tag("a"), tag("A")), false);
  assert.equal(abstractEquals(tag(true), tag(1)), true);
  assert.equal(abstractEquals(tag(null), tag(undefined)), true);
  assert.equal(abstractEquals(tag(Number.NaN), tag(Number.NaN)), false);
  assert.equal(abstractEquals(tag(objectRef(3)), tag("[object Object]")), true);
});

test("== lowers to abstractEq IR and keeps the native limitation visible", () => {
  const result = compile({
    entry: example("abstract-equality"), projectRoot: ROOT, target: "scratch",
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.report.hirDump?.includes("abstractEq"));
  assert.ok(result.report.diagnostics.some((item) =>
    item.code === "TSCR2003" && item.message.includes("native Scratch")));
  assert.deepEqual(interpretModules(result.modules).says, ["true", "false", "false", "true"]);
});
