import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

interface BlockJson {
  opcode: string;
  shadow: boolean;
  inputs: Record<string, unknown>;
  fields: Record<string, [string, unknown]>;
}

function build(entry: string) {
  return compile({ entry: example(entry), projectRoot: ROOT, target: "scratch" });
}

function blocksOf(result: ReturnType<typeof build>): [string, BlockJson][] {
  const graph = JSON.parse(result.report.projectJson!) as {
    targets: { blocks: Record<string, BlockJson> }[];
  };
  return graph.targets.flatMap((target) => Object.entries(target.blocks));
}

test("an edgeActivated hat carries a menu shadow and a numeric threshold", () => {
  const result = build("edge-hat");
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const blocks = blocksOf(result);
  const hat = blocks.find(([, block]) => block.opcode === "event_whengreaterthan")?.[1];
  assert.ok(hat, "missing event_whengreaterthan block");
  assert.deepEqual(hat.inputs.VALUE, [1, [4, "-1"]]);
  const menuId = (hat.inputs.WHENGREATERTHANMENU as [number, string])[1];
  const menu = blocks.find(([id]) => id === menuId)?.[1];
  assert.ok(menu, "menu shadow is not wired to the hat");
  assert.equal(menu.opcode, "event_whengreaterthanmenu");
  assert.equal(menu.shadow, true);
  assert.deepEqual(menu.fields.WHENGREATERTHANMENU, ["timer", null]);
});

test("runtime._step fires the edge hat exactly once", async () => {
  const result = build("edge-hat");
  assert.ok(result.sb3);
  const session = await createStepSession(result.sb3);
  try {
    for (let step = 0; step < 20; step++) session.step();
    assert.deepEqual([...session.says], ["edge fired"]);
  } finally {
    session.close();
  }
});
