import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession, interpretModules } from "@typescratch/testing";

/** Object-call syntax: `Scratch.<category>.<method>(...args)` — no string opcodes. */
function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-objblk-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

test("object-call blocks lower to raw blocks with named inputs", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.motion.moveSteps(10);
  Scratch.looks.say("hello");
  const sum = 20 + 22;
  Scratch.looks.say("" + sum);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const stmts = result.modules[0]!.scripts[0]!.body;
  const rawStmts = stmts.filter((s) => s.k === "rawStmt");
  assert.equal(rawStmts.length, 3, JSON.stringify(stmts));
  const interpreter = interpretModules(result.modules);
  assert.ok(interpreter.says.includes("hello"));
  assert.ok(interpreter.says.includes("42"));
});

test("object-call command + reporter run in real scratch-vm", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.motion.moveSteps(10);
  Scratch.looks.say("" + Scratch.motion.xPosition());
  const sum = 19 + 23;
  Scratch.looks.say("" + sum);
});
`);
assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
const session = await createStepSession(result.sb3!);
try {
  session.greenFlag();
  for (let i = 0; i < 100 && session.activeThreads() > 0; i++) session.step();
  assert.deepEqual([...session.says].sort(), ["10", "42"]);
} finally {
    session.close();
  }
});

test("static field arguments are emitted as Scratch block fields", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.motion.setRotationStyle("left-right");
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const stmt = result.modules[0]!.scripts[0]!.body.find((s) => s.k === "rawStmt") as {
    opcode: string; fields: Record<string, string>;
  };
  assert.equal(stmt.opcode, "motion_setrotationstyle");
  assert.deepEqual(stmt.fields, { STYLE: "left-right" });
});

test("unknown object-call block is rejected with a diagnostic", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.motion.notARealBlock();
});
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR1001" || d.code === "TSCR2001"),
    JSON.stringify(result.report.diagnostics));
});
