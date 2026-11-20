import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";

/**
 * Language design rules (M0):
 * - variables are plain TS `let`, not wrapper objects or .get()/.set()
 * - top-level `let` is sprite-private; @global opts into a Stage variable
 * - operators are TS syntax; no Scratch.operators.* namespace
 */
function compileSource(source: string, target: "scratch" | "turbowarp" = "scratch") {
  const root = mkdtempSync(join(tmpdir(), "tscr-lang-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target });
}

test("top-level let is sprite-local by default", () => {
  const result = compileSource(`
let score = 9;
Scratch.onFlag(() => { score = score + 1; Scratch.say("" + score); });
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const decl = result.modules[0]!.vars.find((v) => v.name.endsWith(".score"))!;
  assert.ok(decl, "score exists");
  assert.equal(decl.storage, "local", "top-level let is private to its sprite");
});

test("@global makes a top-level let a Stage variable", () => {
  const result = compileSource(`
/** @global */
let shared = 9;
Scratch.onFlag(() => { shared = shared + 1; Scratch.say("" + shared); });
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const decl = result.modules[0]!.vars.find((v) => v.name === "shared")!;
  assert.ok(decl);
  assert.equal(decl.storage, "global");
});

test("conflicting @global/@local is rejected with TSCR2010", () => {
  const result = compileSource(`
/** @global @local */
let x = 1;
Scratch.onFlag(() => { Scratch.say("" + x); });
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR2010"),
    JSON.stringify(result.report.diagnostics));
});

test("misplaced TypeScratch decorators are rejected with TSCR2010", () => {
  const result = compileSource(`
/** @warp */
let x = 1;
Scratch.onFlag(() => { Scratch.say("" + x); });
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR2010"),
    JSON.stringify(result.report.diagnostics));
});

test("plain TS assignment runs in real scratch-vm without get()/set()", async () => {
  const result = compileSource(`
/** @global */
let score = 9;
Scratch.onFlag(() => { score = score + 1; Scratch.say("" + score); });
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 100 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["10"]);
  } finally { session.close(); }
});

test("Scratch.global handle API still compiles during the deprecation window", () => {
  const result = compileSource(`
const h = Scratch.global<number>("h", { initial: 1 });
Scratch.onFlag(() => { h.set(h.get() + 1); Scratch.say("" + h.get()); });
`);
  // Kept for backwards compatibility with existing examples/goldens. New code
  // should use a top-level `let` (+ @global when cross-role is needed).
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
});
