import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules, createStepSession } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-inh-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

test("override is called through a base-typed variable and super calls the base", () => {
  const result = compileSource(`
class Animal {
  name: string = "animal";
  speak(): string { return this.name; }
}
class Dog extends Animal {
  constructor() { super(); this.name = "dog"; }
  speak(): string { return super.speak() + "!"; }
}
Scratch.onFlag(() => {
  const d = new Dog();
  const a: Animal = d;
  Scratch.say(a.speak());
  Scratch.say(d.speak());
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["dog!", "dog!"]);
});

test("inherited fields and methods are available on the subclass", () => {
  const result = compileSource(`
class Base {
  value: number = 10;
  twice(): number { return this.value * 2; }
}
class Child extends Base {
  extra: number = 5;
}
Scratch.onFlag(() => {
  const c = new Child();
  Scratch.say("" + c.value);
  Scratch.say("" + c.twice());
  Scratch.say("" + c.extra);
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["10", "20", "5"]);
});

test("two-level hierarchy dispatches to the most derived override", () => {
  const result = compileSource(`
class A { step(): number { return 1; } }
class B extends A { step(): number { return 2; } }
class C extends B { step(): number { return 3; } }
Scratch.onFlag(() => {
  const c = new C();
  const b: B = c;
  const a: A = c;
  Scratch.say("" + a.step());
  Scratch.say("" + b.step());
  Scratch.say("" + c.step());
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["3", "3", "3"]);
});

test("implements is a TypeScript compile-time check", () => {
  const result = compileSource(`
interface Speak { speak(): string; }
class Good implements Speak { speak(): string { return "ok"; } }
class Bad implements Speak { other(): number { return 1; } }
Scratch.onFlag(() => { const g = new Good(); Scratch.say(g.speak()); });`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR1001" && /Speak/.test(d.message)),
    JSON.stringify(result.report.diagnostics));
});

test("inheritance runs in a real scratch-vm", async () => {
  const result = compileSource(`
class Shape {
  size: number = 1;
  area(): number { return this.size; }
}
class Square extends Shape {
  constructor(s: number) { super(); this.size = s; }
  area(): number { return super.area() * this.size; }
}
Scratch.onFlag(() => {
  const s = new Square(4);
  const base: Shape = s;
  Scratch.say("" + base.area());
  Scratch.say("" + s.area());
});`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 300 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["16", "16"]);
  } finally { session.close(); }
});
