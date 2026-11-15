import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";

const PROCCODE = "greet";

interface JsonBlock {
  opcode: string;
  mutation?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

function procedureProject(): Uint8Array {
  const bag = new DiagnosticBag();
  const builder = new GraphBuilder();
  const scope = "procedures-mutation";

  const definition = builder.add("procedures_definition", { scope, topLevel: true, x: 0, y: 0 });
  const prototype = builder.add("procedures_prototype", {
    scope,
    parent: definition,
    shadow: true,
    mutation: {
      tagName: "mutation",
      proccode: PROCCODE,
      argumentnames: "[]",
      argumentids: "[]",
      argumentdefaults: "[]",
      warp: "false",
      children: [],
    },
  });
  builder.input(definition, "custom_block", { shadowBlock: prototype });
  const body = builder.add("looks_say", { scope });
  builder.input(body, "MESSAGE", { primitive: [4, "hi from procedure"] });
  builder.chain([definition, body]);

  const hat = builder.add("event_whenflagclicked", { scope, topLevel: true, x: 0, y: 200 });
  const call = builder.add("procedures_call", {
    scope,
    mutation: {
      tagName: "mutation",
      proccode: PROCCODE,
      argumentids: "[]",
      children: [],
    },
  });
  builder.chain([hat, call]);

  assert.equal(bag.items.length, 0, JSON.stringify(bag.items));
  return exportSb3(builder.project, bag);
}

test("project.json serialises procedure mutations verbatim", () => {
  const files = unzipSync(procedureProject());
  const project = JSON.parse(strFromU8(files["project.json"]!)) as {
    targets: { blocks: Record<string, JsonBlock> }[];
  };
  const blocks = Object.values(project.targets[1]!.blocks);
  const prototype = blocks.find((block) => block.opcode === "procedures_prototype");
  const call = blocks.find((block) => block.opcode === "procedures_call");
  assert.equal(prototype?.mutation?.proccode, PROCCODE);
  assert.equal(prototype?.mutation?.argumentids, "[]");
  assert.equal(call?.mutation?.proccode, PROCCODE);
});

test("a generated custom procedure runs in headless scratch-vm", async () => {
  const session = await createStepSession(procedureProject());
  try {
    session.greenFlag();
    for (let step = 0; step < 40 && session.activeThreads() > 0; step++) session.step();
    assert.deepEqual(session.says, ["hi from procedure"]);
  } finally {
    session.close();
  }
});
