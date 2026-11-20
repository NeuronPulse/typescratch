import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-stdedge-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}
async function run(sb3: Uint8Array): Promise<string[]> {
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let i = 0; i < 200 && session.activeThreads() > 0; i++) session.step();
    return [...session.says];
  } finally { session.close(); }
}

test("Math.log is natural log, consistent with JS", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("" + Math.round(Math.log(Math.E)));
  Scratch.say("" + Math.round(Math.log10(100)));
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual((await run(result.sb3!)).map(Number).sort(), [1, 2]);
});

test("charAt out of range returns empty string like JS", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("[" + "abc".charAt(9) + "]");
  Scratch.say("[" + "abc".charAt(-1) + "]");
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual((await run(result.sb3!)).sort(), ["[]", "[]"]);
});

test("negative literals and exponents fold correctly", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("" + (1e3 + 0x10 + 0b10 + 0o7));
  Scratch.say("" + -5);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  // 1e3=1000, 0x10=16, 0b10=2, 0o7=7 → 1025
  assert.deepEqual((await run(result.sb3!)).sort(), ["-5", "1025"]);
});
