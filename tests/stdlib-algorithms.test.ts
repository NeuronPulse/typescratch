import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules, createStepSession } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-std-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

const PREAMBLE = `import { Scratch } from "@typescratch/runtime";
import { sum, average, min, max, linearSearch, binarySearch, count,
  fillRange, reverse, unique, sort, sortBy } from "@typescratch/stdlib";
`;

function arrayInit(name: string, values: number[]): string {
  let code = `  const ${name} = Scratch.array<number>(${values.length});\n`;
  values.forEach((value, index) => { code += `  ${name}.set(${index}, ${value});\n`; });
  return code;
}

test("sum/average/min/max/count on empty, single and many values", () => {
  const result = compileSource(PREAMBLE + `
Scratch.onFlag(() => {
  const empty = Scratch.array<number>(1);
  const one = Scratch.array<number>(1); one.set(0, 7);
  ${arrayInit("many", [3, 1, 4, 2])}
  Scratch.say("" + sum(empty));
  Scratch.say("" + sum(one));
  Scratch.say("" + sum(many));
  Scratch.say("" + average(many));
  Scratch.say("" + min(many));
  Scratch.say("" + max(many));
  Scratch.say("" + count(many, 4));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["0", "7", "10", "2.5", "1", "4", "1"]);
});

test("linearSearch and binarySearch", () => {
  const result = compileSource(PREAMBLE + `
Scratch.onFlag(() => {
  ${arrayInit("values", [1, 3, 5, 7])}
  Scratch.say("" + linearSearch(values, 5));
  Scratch.say("" + linearSearch(values, 4));
  Scratch.say("" + binarySearch(values, 7));
  Scratch.say("" + binarySearch(values, 6));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["2", "-1", "3", "-1"]);
});

test("fillRange/reverse/unique with caller-owned destination", () => {
  const result = compileSource(PREAMBLE + `
Scratch.onFlag(() => {
  const dst = Scratch.array<number>(5);
  Scratch.say("" + fillRange(dst, 10, 5));
  Scratch.say("" + dst.get(0) + "/" + dst.get(4));
  const values = Scratch.array<number>(5);
  reverse(dst, values);
  Scratch.say("" + values.get(0) + "/" + values.get(4));
  const sorted = Scratch.array<number>(5);
  fillRange(sorted, 1, 5);
  sorted.set(1, 1); sorted.set(2, 2); sorted.set(3, 2);
  Scratch.say("" + unique(sorted, dst));
  Scratch.say("" + dst.get(0) + "/" + dst.get(2));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says,
    ["5", "10/14", "14/10", "3", "1/5"]);
});

test("sort and sortBy with a closure comparator", () => {
  const result = compileSource(PREAMBLE + `
Scratch.onFlag(() => {
  ${arrayInit("asc", [3, 1, 4, 2])}
  ${arrayInit("desc", [3, 1, 4, 2])}
  const dst = Scratch.array<number>(4);
  sort(asc, dst);
  Scratch.say("" + dst.get(0) + "/" + dst.get(1) + "/" + dst.get(2) + "/" + dst.get(3));
  const greater = (a: number, b: number): boolean => a > b;
  sortBy(desc, greater, dst);
  Scratch.say("" + dst.get(0) + "/" + dst.get(3));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["1/2/3/4", "4/1"]);
});

test("standard library runs in a real scratch-vm", async () => {
  const result = compileSource(PREAMBLE + `
Scratch.onFlag(() => {
  ${arrayInit("values", [5, 2, 9, 1])}
  const dst = Scratch.array<number>(4);
  sort(values, dst);
  Scratch.say("" + sum(dst));
  Scratch.say("" + dst.get(0) + "/" + dst.get(3));
  Scratch.say("" + binarySearch(dst, 5));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 600 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["17", "1/9", "2"]);
  } finally { session.close(); }
});
