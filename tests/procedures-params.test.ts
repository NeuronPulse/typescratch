import { test } from "vitest";
import assert from "node:assert/strict";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";

const PROCCODE = "greet %s";
const ARG_IDS = '["input0"]';

function parameterisedProject(): Uint8Array {
  const bag = new DiagnosticBag();
  const builder = new GraphBuilder();
  const scope = "procedures-params";

  const definition = builder.add("procedures_definition", { scope, topLevel: true, x: 0, y: 0 });
  const prototype = builder.add("procedures_prototype", {
    scope,
    parent: definition,
    shadow: true,
    mutation: {
      tagName: "mutation",
      proccode: PROCCODE,
      argumentnames: '["who"]',
      argumentids: ARG_IDS,
      argumentdefaults: '[""]',
      warp: "false",
      children: [],
    },
  });
  builder.input(definition, "custom_block", { shadowBlock: prototype });

  const join = builder.add("operator_join", { scope });
  builder.input(join, "STRING1", { primitive: [10, "hi "] });
  const reporter = builder.add("argument_reporter_string_number", {
    scope,
    fields: { VALUE: ["who", null] },
  });
  builder.input(join, "STRING2", { block: reporter });
  const body = builder.add("looks_say", { scope });
  builder.input(body, "MESSAGE", { block: join });
  builder.chain([definition, body]);

  const hats: { opcode: string; value: string; fields?: Record<string, [string, string | null]> }[] = [
    { opcode: "event_whenflagclicked", value: "A" },
    {
      opcode: "event_whenkeypressed",
      value: "B",
      fields: { KEY_OPTION: ["space", null] },
    },
  ];
  hats.forEach((hat, index) => {
    const top = builder.add(hat.opcode, {
      scope: `${scope}/hat${index}`,
      topLevel: true,
      x: 0,
      y: 200 + index * 200,
      fields: hat.fields,
    });
    const call = builder.add("procedures_call", {
      scope: `${scope}/hat${index}`,
      mutation: {
        tagName: "mutation",
        proccode: PROCCODE,
        argumentids: ARG_IDS,
        children: [],
      },
    });
    builder.input(call, "input0", { primitive: [10, hat.value] });
    builder.chain([top, call]);
  });

  assert.equal(bag.items.length, 0, JSON.stringify(bag.items));
  return exportSb3(builder.project, bag);
}

test("concurrent calls keep procedure arguments thread-private", async () => {
  const session = await createStepSession(parameterisedProject());
  try {
    session.greenFlag();
    session.startHat("event_whenkeypressed", { KEY_OPTION: "space" });
    assert.equal(session.activeThreads(), 2);
    for (let step = 0; step < 60 && session.activeThreads() > 0; step++) session.step();
    assert.deepEqual([...session.says].sort(), ["hi A", "hi B"]);
  } finally {
    session.close();
  }
});
