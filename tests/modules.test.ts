import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules, createStepSession } from "@typescratch/testing";

/** Build a temp project from a literal map of relative paths to sources. */
function compileProject(files: Record<string, string>, entry = "main.ts") {
  const root = mkdtempSync(join(tmpdir(), "tscr-mod-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, "src", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return compile({ entry: join(root, "src", entry), projectRoot: join(root, "src"), target: "scratch" });
}

test("import a function and const across modules, with an alias", () => {
  const result = compileProject({
    "lib.ts": `export function add(a: number, b: number): number { return a + b; }\nexport const label: string = "sum";\n`,
    "main.ts": `import { add as plus, label } from "./lib";
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => { Scratch.say(label + ":" + plus(2, 3)); });`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["sum:5"]);
});

test("re-export is resolved through the checker", () => {
  const result = compileProject({
    "lib.ts": `export function add(a: number, b: number): number { return a + b; }\n`,
    "barrel.ts": `export { add } from "./lib";\nexport const extra: number = 3;\n`,
    "main.ts": `import { add, extra } from "./barrel";
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => Scratch.say("" + add(extra, 4)));`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["7"]);
});

test("same class name in two modules stays distinct", () => {
  const result = compileProject({
    "a.ts": `export class Widget { value: number = 10; }\n`,
    "b.ts": `export class Widget { value: number = 99; }\n`,
    "main.ts": `import { Widget as W1 } from "./a";
import { Widget as W2 } from "./b";
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => { const a = new W1(); const b = new W2(); Scratch.say("" + a.value + "/" + b.value); });`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["10/99"]);
});

test("same top-level variable name in two modules gets distinct Scratch names", () => {
  const result = compileProject({
    "a.ts": `export let value: number = 11;\n`,
    "b.ts": `export let value: number = 22;\n`,
    "main.ts": `import { value as a } from "./a";
import { value as b } from "./b";
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => Scratch.say("" + a + "/" + b));`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const names = result.modules[0]!.vars.filter((v) => v.name.includes("value")).map((v) => v.name);
  assert.equal(new Set(names).size, names.length, `duplicate Scratch variable names: ${names}`);
  assert.deepEqual(interpretModules(result.modules).says, ["11/22"]);
});

test("import cycles are rejected with TSCR2008", () => {
  const result = compileProject({
    "a.ts": `import { b } from "./b";\nexport const a: number = b;\n`,
    "b.ts": `import { a } from "./a";\nexport const b: number = a;\n`,
    "main.ts": `import { a } from "./a";
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => Scratch.say("" + a));`,
  });
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR2008"),
    JSON.stringify(result.report.diagnostics));
});

test("imported function/class/const run in a real scratch-vm", async () => {
  const result = compileProject({
    "lib.ts": `export class P {
  value: number = 0;
  constructor(v: number) { this.value = v; }
  get double(): number { return this.value * 2; }
}
export function sum(a: number, b: number): number { return a + b; }
`,
    "main.ts": `import { P, sum } from "./lib";
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => {
  const p = new P(6);
  Scratch.say("" + p.double);
  Scratch.say("" + sum(p.value, 3));
});`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 300 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["12", "9"]);
  } finally { session.close(); }
});
