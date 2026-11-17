import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession, interpretModules } from "@typescratch/testing";

// TypeScript 6 (the pinned version) only allows decorators on classes, methods,
// properties, parameters and accessors. `@warp function f()` is a syntax error
// at the TS layer (TSCR1001), so the supported API is a method decorator:
//   class Calc { @warp fast(x: number): number { ... } }
// Methods are TypeScratch FunctionDecls and lower to the same procedures.
const PREAMBLE = `import { Scratch, warp, noWarp } from "@typescratch/runtime";\n`;

function compileSource(source: string, profile: "native" | "extension" = "native") {
  const root = mkdtempSync(join(tmpdir(), "tscr-warp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, PREAMBLE + source);
  return compile({ entry, projectRoot: root, target: "scratch", abiProfile: profile });
}

// Real headless scratch-vm: run the project, assert SAY output via the SAY hook,
// and read the actual procedures_prototype mutation.warp from the loaded VM.
async function runHeadless(sb3: Uint8Array) {
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 120 && session.activeThreads() > 0; step++) session.step();
    return { says: [...session.says].sort(), procedures: session.procedures() };
  } finally {
    session.close();
  }
}

const WARP_SOURCE = `
class Calc {
  @warp fast(x: number): number { return x + 1; }
}
Scratch.onFlag(() => { const c = new Calc(); Scratch.say(c.fast(41)); });
`;
const NO_WARP_SOURCE = `
class Calc {
  @noWarp slow(x: number): number { return x + 1; }
}
Scratch.onFlag(() => { const c = new Calc(); Scratch.say(c.slow(41)); });
`;
const DEFAULT_SOURCE = `
class Calc {
  plain(x: number): number { return x + 1; }
}
Scratch.onFlag(() => { const c = new Calc(); Scratch.say(c.plain(41)); });
`;

test("@warp on a method sets warp=true in the real scratch-vm procedure", async () => {
  const result = compileSource(WARP_SOURCE);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.equal(result.modules[0]!.functions?.[0]!.warp, true);
  assert.deepEqual(interpretModules(result.modules).says, ["42"]);
  assert.ok(result.sb3);
  const { says, procedures } = await runHeadless(result.sb3);
  assert.deepEqual(says, ["42"]);
  assert.deepEqual(procedures.map((p) => p.warp), ["true"]);
});

test("@noWarp and unannotated methods keep warp=false in scratch-vm", async () => {
  for (const source of [NO_WARP_SOURCE, DEFAULT_SOURCE]) {
    const result = compileSource(source);
    assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
    assert.deepEqual(interpretModules(result.modules).says, ["42"]);
    assert.ok(result.sb3);
    const { says, procedures } = await runHeadless(result.sb3);
    assert.deepEqual(says, ["42"]);
    assert.deepEqual(procedures.map((p) => p.warp), ["false"]);
  }
});

test("a warp method in a call chain keeps the callee default in scratch-vm", async () => {
  const result = compileSource(`
class C {
  @warp outer(x: number): number { return this.inner(x) + 1; }
  inner(x: number): number { return x * 2; }
}
Scratch.onFlag(() => { const c = new C(); Scratch.say(c.outer(20)); });
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, ["41"]);
  assert.ok(result.sb3);
  const { says, procedures } = await runHeadless(result.sb3);
  assert.deepEqual(says, ["41"]);
  assert.deepEqual(procedures.map((p) => p.warp).sort(), ["false", "true"]);
});

test("@warp on a recursive method is rejected with TSCR3003", () => {
  const result = compileSource(`
class R {
  @warp countdown(n: number): number {
    if (n <= 0) return 0;
    return this.countdown(n - 1);
  }
}
Scratch.onFlag(() => { const r = new R(); Scratch.say(r.countdown(3)); });
`);
  assert.equal(result.ok, false, JSON.stringify(result.report.diagnostics));
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR3003"), JSON.stringify(result.report.diagnostics));
});

test("duplicate and conflicting warp decorators are rejected with TSCR3003", () => {
  for (const decorator of ["@warp\n@warp", "@warp\n@noWarp"]) {
    const result = compileSource(`
class C {
  ${decorator}
  f(x: number): number { return x; }
}
Scratch.onFlag(() => { const c = new C(); Scratch.say(c.f(1)); });
`);
    assert.equal(result.ok, false, decorator + JSON.stringify(result.report.diagnostics));
    assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR3003"), decorator + JSON.stringify(result.report.diagnostics));
  }
});

test("warp decorators on non-method declarations are rejected with TSCR3003", () => {
  const result = compileSource(`
declare function classWarp(value: unknown): void;
@classWarp
class C { value: number = 1; }
Scratch.onFlag(() => { const c = new C(); Scratch.say(c.value); });
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR3003"), JSON.stringify(result.report.diagnostics));
});

test("an unknown decorator is never silently ignored", () => {
  const result = compileSource(`
declare function mystery(value: unknown, context: unknown): void;
class C {
  @mystery
  f(x: number): number { return x; }
}
Scratch.onFlag(() => { const c = new C(); Scratch.say(c.f(1)); });
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR3003"), JSON.stringify(result.report.diagnostics));
});

test("@warp under the extension ABI profile fails at plan time with TSCR3004", () => {
  const result = compileSource(WARP_SOURCE, "extension");
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR3004"), JSON.stringify(result.report.diagnostics));
});

test("@warp on a top-level function is a TypeScript syntax error, not silently accepted", () => {
  const result = compileSource(`
@warp
function f(x: number): number { return x; }
Scratch.onFlag(() => { Scratch.say(f(1)); });
`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR1001"), JSON.stringify(result.report.diagnostics));
});
