import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";

/** Native-only standard library: Math constants/functions and String basics. */
function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-stdlib-"));
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
  } finally {
    session.close();
  }
}

test("Math.PI and Math.E are compile-time constants", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("" + (Math.PI > 3.14 && Math.PI < 3.15));
  Scratch.say("" + (Math.E > 2.71 && Math.E < 2.72));
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
});

test("trig functions use radians like JS, not Scratch degrees", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("" + Math.round(Math.sin(Math.PI / 2) * 100));
  Scratch.say("" + Math.round(Math.cos(Math.PI) * 100));
  Scratch.say("" + Math.round(Math.asin(1) * 100 / Math.PI));
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const says = await run(result.sb3!);
  // sin(π/2)=1 → 100, cos(π)=-1 → -100, asin(1)=π/2 → ~50
  assert.deepEqual(says.map(Number).sort((a, b) => a - b), [-100, 50, 100]);
});

test("log/ln/exp/abs/floor/ceil/round map to native blocks", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.say("" + Math.round(Math.abs(-7)));
  Scratch.say("" + Math.floor(2.9));
  Scratch.say("" + Math.ceil(2.1));
  Scratch.say("" + Math.round(2.5));
  Scratch.say("" + Math.round(Math.log10(1000)));
  Scratch.say("" + Math.round(Math.exp(0)));
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  // abs(-7)=7, floor(2.9)=2, ceil(2.1)=3, round(2.5)=3, log10(1000)=3, exp(0)=1
  assert.deepEqual((await run(result.sb3!)).map(Number).sort((a, b) => a - b), [1, 2, 3, 3, 3, 7]);
});

test("native string methods: charAt / includes / length", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const s = "hello";
  Scratch.say(s.charAt(1));
  Scratch.say("" + s.includes("ell"));
  Scratch.say("" + s.length);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual((await run(result.sb3!)).sort(), ["5", "e", "true"]);
});

test("null/undefined and literals get clear diagnostics", () => {
  for (const [body, hint] of [
    [`const x = null;`, "null has no Scratch representation"],
    [`const x = undefined;`, "undefined has no Scratch representation"],
    [`const x = [1, 2];`, "array literals are not supported"],
    [`const x = 1e400;`, "not finite"],
  ] as const) {
    const result = compileSource(`Scratch.onFlag(() => { ${body} });`);
    assert.equal(result.ok, false, body);
    assert.ok(result.report.diagnostics.some((d) => d.message.includes(hint)),
      body + JSON.stringify(result.report.diagnostics));
  }
});
