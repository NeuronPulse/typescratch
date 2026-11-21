import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules, createStepSession } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-cl-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

test("arrow closure captures a const by value", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const base = 10;
  const add = (x: number): number => base + x;
  Scratch.say("" + add(5));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["15"]);
});

test("two independent closures over the same declaration dispatch correctly", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const n = 3;
  const plus = (x: number): number => n + x;
  const times = (x: number): number => n * x;
  Scratch.say("" + plus(4));
  Scratch.say("" + times(4));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["7", "12"]);
});

test("capturing a mutable let is rejected rather than silently snapshotted", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  let n = 1;
  const f = (): number => n;
  n = 99;
  Scratch.say("" + f());
});`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => /mutable variable/.test(d.message)),
    JSON.stringify(result.report.diagnostics));
});

test("closure in a loop body gets a fresh object each iteration", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const base = 1;
  let i = 0;
  while (i < 3) {
    const f = (x: number): number => base + x;
    Scratch.say("" + f(10));
    i = i + 1;
  }
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["11", "11", "11"]);
});

test("closures run in a real scratch-vm", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const a = 2;
  const b = 5;
  const sum = (x: number): number => a + b + x;
  const product = (x: number): number => a * b * x;
  Scratch.say("" + sum(3));
  Scratch.say("" + product(3));
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 400 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["10", "30"]);
  } finally { session.close(); }
});
