import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules } from "@typescratch/testing";
import type { Module } from "@typescratch/ir";

const span = { file: "synthetic.ts", start: 0, end: 0, line: 1, column: 1 } as const;
const text = (value: string) => ({ k: "const" as const, value, type: "string" as const, span });
const say = (message: string) => ({
  k: "expr" as const, name: "say", args: [text(message)], span,
});

function build(code: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-try-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => { ${code} });`);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

test("tryCall binds a typed string failure and runs the handler", () => {
  const module: Module = {
    entry: "synthetic.ts", vars: [
      { id: "e", name: "e", type: "string", storage: "temp", script: 0, span },
    ],
    lists: [],
    scripts: [{
      hat: { kind: "flag" },
      body: [{
        k: "tryCall", errorVar: "e", span,
        body: [say("before"), { k: "raise", value: text("boom"), span }, say("unreachable")],
        handler: [{ k: "expr", name: "say", args: [
          { k: "join", parts: [text("caught:"), { k: "read", var: "e", type: "string", span }], type: "string", span },
        ], span }],
      }, say("after")],
    }],
  };
  assert.deepEqual(interpretModules([module]).says, ["before", "caught:boom", "after"]);
});

test("an uncaught raise stops the script — no in-band default", () => {
  const module: Module = {
    entry: "synthetic.ts", vars: [], lists: [],
    scripts: [{ hat: { kind: "flag" }, body: [
      { k: "raise", value: text("fatal"), span }, say("unreachable"),
    ] }],
  };
  assert.throws(() => interpretModules([module]), /typed failure: fatal/);
});

test("native backend reports try/catch and throw honestly", () => {
  const result = build(`try { throw "x"; } catch (e) { Scratch.say("" + e); }`);
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((item) =>
    item.code === "TSCR3001" && item.message.includes("try/catch")));
  const thrown = build(`throw "fatal"; Scratch.say("unreachable");`);
  assert.equal(thrown.ok, false);
  assert.ok(thrown.report.diagnostics.some((item) =>
    item.code === "TSCR3001" && item.message.includes("throw")));
});
