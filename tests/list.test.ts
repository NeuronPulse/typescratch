import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { interpretModules } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

interface ListBlock {
  opcode: string;
  inputs: Record<string, unknown>;
  fields: Record<string, unknown>;
}

interface ListProject {
  targets: {
    name: string;
    isStage: boolean;
    lists: Record<string, [string, unknown[]]>;
    blocks: Record<string, ListBlock>;
  }[];
}

function build() {
  const result = compile({ entry: example("list"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  return {
    result,
    project: JSON.parse(strFromU8(raw)) as ListProject,
  };
}

test("list declarations and operations appear in the HIR", () => {
  const { result } = build();
  const module = result.modules[0]!;
  assert.equal(module.lists.length, 1);
  assert.equal(module.lists[0]?.name, "items");
  assert.equal(module.lists[0]?.type, "number");
  const statements = module.scripts[0]!.body;
  const ops = statements.filter((stmt) => stmt.k === "list").map((stmt) => stmt.k === "list" ? stmt.op : "");
  assert.deepEqual(ops, ["push", "push", "insert", "replace", "deleteAt", "clear"]);
});

test("list blocks use native data_* opcodes and 1-based indices", () => {
  const { project } = build();
  const sprite = project.targets.find((target) => !target.isStage)!;
  const blocks = Object.values(sprite.blocks);
  for (const opcode of [
    "data_addtolist", "data_lengthoflist", "data_itemoflist",
    "data_insertatlist", "data_replaceitemoflist", "data_deleteoflist", "data_deletealloflist",
  ]) {
    assert.ok(blocks.some((block) => block.opcode === opcode), `missing ${opcode}`);
  }
  assert.deepEqual(Object.values(sprite.lists), [["items", []]]);
  for (const block of blocks) {
    if (!block.opcode.startsWith("data_")) continue;
    const field = block.fields["LIST"];
    assert.ok(Array.isArray(field) && field.length === 2, `${block.opcode} has a [name, id] LIST field`);
    assert.equal(field[0], "items");
  }
  const itemOf = blocks.find((block) => block.opcode === "data_itemoflist")!;
  const index = itemOf.inputs["INDEX"] as [number, string];
  assert.equal(index[0], 3);
  const add = sprite.blocks[index[1]]!;
  assert.equal(add.opcode, "operator_add");
});

test("the IR interpreter models zero-based list semantics", () => {
  const { result } = build();
  const trace = interpretModules(result.modules);
  assert.deepEqual(trace.says, ["2", "7", "11", "2", "0"]);
  assert.deepEqual(trace.lists["Sprite1:items"], []);
});
