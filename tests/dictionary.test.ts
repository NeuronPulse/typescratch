import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules, createStepSession } from "@typescratch/testing";

/**
 * Dictionary = parallel Scratch lists with a generated linear scan (O(n)).
 * Number keys only in v1 — string keys are rejected (Scratch == is
 * case-insensitive and would conflate "A"/"a").
 */
function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-map-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

const BASIC = `
const m = Scratch.map<number, number>();
Scratch.onFlag(() => {
  m.set(1, 10);
  m.set(2, 20);
  Scratch.say("" + m.get(1));
  Scratch.say("" + m.get(2));
  Scratch.say("" + m.has(1));
  Scratch.say("" + m.has(99));
  Scratch.say("" + m.size());
});
`;

test("dictionary set/get/has/size work in the interpreter", () => {
  const result = compileSource(BASIC);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["10", "20", "true", "false", "2"]);
});

test("overwrite and delete work", () => {
  const result = compileSource(`
const m = Scratch.map<number, number>();
Scratch.onFlag(() => {
  m.set(1, 10);
  m.set(1, 99);
  Scratch.say("" + m.get(1));
  Scratch.say("" + m.size());
  m.delete(1);
  Scratch.say("" + m.has(1));
  Scratch.say("" + m.size());
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["99", "1", "false", "0"]);
});

test("clear resets the dictionary", () => {
  const result = compileSource(`
const m = Scratch.map<number, number>();
Scratch.onFlag(() => {
  m.set(1, 10);
  m.set(2, 20);
  m.clear();
  Scratch.say("" + m.size());
  Scratch.say("" + m.has(1));
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["0", "false"]);
});

test("the generated linear-scan blocks run in real scratch-vm", async () => {
  const result = compileSource(`
const m = Scratch.map<number, number>();
Scratch.onFlag(() => {
  m.set(1, 10);
  m.set(2, 20);
  m.set(1, 99);
  Scratch.say("" + m.get(1));
  Scratch.say("" + m.get(2));
  Scratch.say("" + m.has(3));
  Scratch.say("" + m.size());
  m.delete(1);
  Scratch.say("" + m.has(1));
  Scratch.say("" + m.size());
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 300 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says], ["99", "20", "false", "2", "false", "1"]);
  } finally { session.close(); }
});

test("string keys are rejected with a clear diagnostic", () => {
  const result = compileSource(`
const m = Scratch.map<string, number>();
Scratch.onFlag(() => { m.set("a", 1); });
`);
  assert.equal(result.ok, false);
  // Rejected by the TS type constraint `K extends number` — the frontend's
  // own diagnostic is a backup for non-generic call sites.
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR1001" || /keys must be number/.test(d.message)),
    JSON.stringify(result.report.diagnostics));
});
