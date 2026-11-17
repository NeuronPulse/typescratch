import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession, interpretModules } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-streq-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

async function run(sb3: Uint8Array): Promise<string[]> {
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 20000 && session.activeThreads() > 0; step++) session.step();
    return [...session.says].sort();
  } finally {
    session.close();
  }
}

const EXPECTED = ["false", "true", "true", "false", "false", "true", "true", "true"];

const SOURCE = `
Scratch.onFlag(() => {
  let a: string = "A";
  let b: string = "a";
  let hello: string = "Hello";
  let hello2: string = "Hello";
  let n1: string = "10";
  let n2: string = "10.0";
  let uni: string = "é";
  let cjk: string = "中";
  let emoji: string = "😀";
  Scratch.say("" + (a == b));            // false (case)
  Scratch.say("" + (a == a));            // true
  Scratch.say("" + (hello == hello2));   // true
  Scratch.say("" + (n1 == n2));          // false (length)
  Scratch.say("" + (uni == cjk));        // false (gate)
  Scratch.say("" + (uni == uni));        // true
  Scratch.say("" + (emoji == emoji));    // true
  Scratch.say("" + (a != b));            // true (negate)
});
`;

test("runtime string == is case-sensitive in headless scratch-vm", async () => {
  const result = compileSource(SOURCE);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, EXPECTED);
  assert.ok(result.sb3);
  assert.deepEqual(await run(result.sb3), [...EXPECTED].sort());
});

test("literal vs literal still folds with case-sensitive semantics", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("" + (("A" as unknown) == "a"));
  Scratch.say("" + (("Hello" as unknown) == "Hello"));
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["false", "true"]);
});
