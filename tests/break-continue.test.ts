import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { validateModule, type Module, type Stmt } from "@typescratch/ir";
import { interpretModules } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

function allStatements(stmts: Stmt[]): Stmt[] {
  return stmts.flatMap((stmt) => {
    if (stmt.k === "if") {
      return [stmt, ...allStatements(stmt.then), ...allStatements(stmt.else ?? [])];
    }
    if (stmt.k === "while" || stmt.k === "sequence") {
      return [stmt, ...allStatements(stmt.body)];
    }
    return [stmt];
  });
}

function build(optimize?: boolean) {
  return compile({
    entry: example("break-continue"),
    projectRoot: ROOT,
    target: "scratch",
    optimize,
  });
}

test("break and continue are rewritten into guarded control flow", () => {
  const result = build();
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.equal(result.report.optimization.controlFlowRewrites, 1);
  const statements = allStatements(result.modules[0]!.scripts[0]!.body);
  assert.equal(statements.some((stmt) => stmt.k === "break" || stmt.k === "continue"), false);
  assert.ok(result.modules[0]!.vars.some((decl) => decl.name.includes("cf1_done")));
  assert.ok(result.modules[0]!.vars.some((decl) => decl.name.includes("cf2_skip")));
});

test("the rewritten loop keeps JavaScript break/continue semantics", () => {
  const expected = ["1", "3", "4", "done"];
  assert.deepEqual(interpretModules(build().modules).says, expected);
  assert.deepEqual(interpretModules(build(false).modules).says, expected);
});

test("native blocks implement the rewrite without a stop-this-script shortcut", () => {
  const result = build();
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  const project = JSON.parse(strFromU8(raw)) as {
    targets: { blocks: Record<string, { opcode: string }> }[];
  };
  const opcodes = project.targets.flatMap((target) =>
    Object.values(target.blocks).map((block) => block.opcode),
  );
  for (const opcode of ["control_repeat_until", "control_if", "operator_add", "operator_equals"]) {
    assert.ok(opcodes.includes(opcode), `missing ${opcode}`);
  }
  assert.equal(opcodes.includes("control_stop"), false);
});

test("rewritten control-flow temporaries are checked across yields", () => {
  const result = compile({
    entry: example("yield-control-flow"),
    projectRoot: ROOT,
    target: "scratch",
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.report.diagnostics.some((item) => item.code === "TSCR4002"),
    JSON.stringify(result.report.diagnostics),
  );
});

test("break outside a loop is rejected by IR validation", () => {
  const bag = new DiagnosticBag();
  const module: Module = {
    entry: "synthetic.ts",
    vars: [],
    lists: [],
    scripts: [{
      hat: { kind: "flag" },
      body: [
        { k: "expr", name: "say", args: [{ k: "const", value: "x", type: "string" }] },
        { k: "break" },
      ],
    }],
  };
  validateModule(module, bag);
  assert.ok(bag.items.some((item) => item.code === "TSCR2001" && item.message.includes("break")));
});
