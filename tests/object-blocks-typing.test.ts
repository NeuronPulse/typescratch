import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";

/**
 * The object-call API is typed from runtime.d.ts: a command returns `void`
 * and a reporter returns its value type. Using a command where a value is
 * expected is rejected by TypeScript before TypeScratch sees the code — no
 * special compiler diagnostic needed, and no runtime surprise.
 */
function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-objtype-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

test("a reporter's type is usable as a value", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const x: number = Scratch.motion.xPosition();
  const s: string = Scratch.operators.join("a", "b");
  Scratch.looks.say(s + x);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
});

test("a command cannot be used where a value is expected", () => {
  for (const body of [
    `const x: number = Scratch.looks.say("hello");`,
    `const x = Scratch.looks.say("hello"); Scratch.looks.say("" + x);`,
    `Scratch.looks.say(Scratch.looks.say("hello") as unknown as string);`,
  ]) {
    const result = compileSource(`Scratch.onFlag(() => { ${body} });`);
    assert.equal(result.ok, false, body);
    assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR1001" || d.code === "TSCR2001"),
      body + JSON.stringify(result.report.diagnostics));
  }
});
