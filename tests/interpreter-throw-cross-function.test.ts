import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-throw-xfn-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  const result = compile({ entry, projectRoot: root, target: "scratch" });
  // Native lowering intentionally rejects try/catch (TSCR3001); the IR is
  // still produced and is what the interpreter executes.
  assert.ok(result.report.diagnostics.every((d) => d.code === "TSCR3001" || d.code === "TSCR3003"),
    JSON.stringify(result.report.diagnostics));
  return result;
}

test("a non-recursive throw crossing a function boundary keeps subsequent calls correct", () => {
  const result = compileSource(`
function inner(x: number): number {
  if (x > 0) throw "boom";
  return x;
}
Scratch.onFlag(() => {
  try { Scratch.say(inner(1)); } catch (e) { Scratch.say("caught:" + e); }
  Scratch.say(inner(0));
});
`);
  assert.deepEqual(interpretModules(result.modules).says, ["caught:boom", "0"]);
});

test("a throw from a recursive callee restores the caller's parameter", () => {
  const result = compileSource(`
function rec(n: number): number {
  if (n > 1) {
    try {
      Scratch.say(rec(n - 1));
    } catch (e) {
      Scratch.say("caught:" + e);
    }
  } else {
    throw "boom";
  }
  Scratch.say("n=" + n);
  return n;
}
Scratch.onFlag(() => { Scratch.say(rec(2)); });
`);
  // Outer rec(2) must still see n === 2 after the inner rec(1) threw and was
  // caught. Without restoring temps in execFunction, n would be 1.
  assert.deepEqual(interpretModules(result.modules).says, ["caught:boom", "n=2", "2"]);
});
