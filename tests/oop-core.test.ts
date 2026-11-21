import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules, createStepSession } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-oop-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

test("constructor arguments initialize fields", () => {
  const result = compileSource(`
class P {
  x: number = 0;
  label: string = "";
  constructor(n: number, s: string) { this.x = n; this.label = s; }
}
Scratch.onFlag(() => {
  const p = new P(7, "ok");
  Scratch.say("" + p.x);
  Scratch.say(p.label);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["7", "ok"]);
});

test("constructor without args keeps the existing lowering", () => {
  const result = compileSource(`
class P { x: number = 3; constructor() { this.x = 4; } }
Scratch.onFlag(() => { const p = new P(); Scratch.say("" + p.x); });
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["4"]);
});

test("new with args on a class without a constructor is diagnosed", () => {
  const result = compileSource(`
class P { x: number = 3; }
Scratch.onFlag(() => { const p = new P(1); });
`);
  assert.equal(result.ok, false);
  // TS type-checking catches this first when the class has no ctor; the
  // compiler's own diagnostic is a backup for non-generic call sites.
  assert.ok(result.report.diagnostics.some(
    (d) => /no constructor/.test(d.message) || d.code === "TSCR1001"),
    JSON.stringify(result.report.diagnostics));
});

test("boolean fields round-trip through constructor and assignment", () => {
  const result = compileSource(`
class P {
  flag: boolean = false;
  constructor(b: boolean) { this.flag = b; }
  flip(): void { this.flag = false; }
}
Scratch.onFlag(() => {
  const p = new P(true);
  Scratch.say("" + p.flag);
  p.flip();
  Scratch.say("" + p.flag);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["true", "false"]);
});

test("static fields and methods are shared across instances", () => {
  const result = compileSource(`
class C {
  static count: number = 0;
  static bump(): void { C.count = C.count + 1; }
  static label: string = "hi";
}
Scratch.onFlag(() => {
  const a = new C();
  const b = new C();
  C.bump(); C.bump();
  Scratch.say("" + C.count);
  Scratch.say(C.label);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["2", "hi"]);
});

test("getter/setter sugar works", () => {
  const result = compileSource(`
class Box {
  private v: number = 5;
  get x(): number { return this.v; }
  set x(n: number) { this.v = n; }
}
Scratch.onFlag(() => {
  const b = new Box();
  b.x = 9;
  Scratch.say("" + b.x);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["9"]);
});

test("private members are rejected on external access", () => {
  const result = compileSource(`
class Box {
  private v: number = 5;
}
Scratch.onFlag(() => { const b = new Box(); Scratch.say("" + b.v); });
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some(
    (d) => d.code === "TSCR2007" || /private/.test(d.message)),
    JSON.stringify(result.report.diagnostics));
});

test("all OOP features run in a real scratch-vm", async () => {
  const result = compileSource(`
class P {
  static total: number = 0;
  flag: boolean = false;
  value: number = 0;
  constructor(v: number, b: boolean) { this.value = v; this.flag = b; P.total = P.total + 1; }
  get double(): number { return this.value * 2; }
  set double(n: number) { this.value = n / 2; }
}
Scratch.onFlag(() => {
  const a = new P(6, true);
  const b = new P(10, false);
  Scratch.say("" + a.double);
  a.double = 20;
  Scratch.say("" + a.value);
  Scratch.say("" + b.flag);
  Scratch.say("" + P.total);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 400 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["12", "10", "false", "2"]);
  } finally { session.close(); }
});
