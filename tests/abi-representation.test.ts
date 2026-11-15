import { test } from "vitest";
import assert from "node:assert/strict";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";

const PROBE_ID = "l_abi_probe";
const PROBE_NAME = "abiProbe";

function probeProject(): Uint8Array {
  const bag = new DiagnosticBag();
  const builder = new GraphBuilder();
  builder.declareList(PROBE_ID, PROBE_NAME, []);
  const scope = "abi-representation";
  const chain = [builder.add("event_whenflagclicked", { scope, topLevel: true })];
  const cases: { opcode: string; left: string; right: string }[] = [
    { opcode: "operator_divide", left: "1", right: "0" },
    { opcode: "operator_divide", left: "0", right: "0" },
    { opcode: "operator_multiply", left: "-1", right: "0" },
    { opcode: "operator_divide", left: "-1", right: "0" },
  ];
  cases.forEach((item, index) => {
    const reporter = builder.add(item.opcode, { scope: `${scope}/${index}` });
    builder.input(reporter, "NUM1", { primitive: [4, item.left] });
    builder.input(reporter, "NUM2", { primitive: [4, item.right] });
    const add = builder.add("data_addtolist", {
      scope: `${scope}/${index}`,
      fields: { LIST: [PROBE_NAME, PROBE_ID] },
    });
    builder.input(add, "ITEM", { block: reporter });
    chain.push(add);
  });
  builder.chain(chain);
  assert.equal(bag.items.length, 0, JSON.stringify(bag.items));
  return exportSb3(builder.project, bag);
}

test("Scratch lists preserve IEEE-754 special values through a store/read round trip", async () => {
  const session = await createStepSession(probeProject());
  try {
    session.greenFlag();
    for (let step = 0; step < 20 && session.activeThreads() > 0; step++) session.step();
    const probe = session.lists()[`Sprite1:${PROBE_NAME}`] ?? [];
    assert.equal(probe.length, 4, `unexpected probe length: ${JSON.stringify(probe)}`);
    assert.equal(probe[0], Infinity);
    assert.ok(Number.isNaN(probe[1]), `NaN became ${String(probe[1])}`);
    assert.ok(Object.is(probe[2], -0), `-0 became ${String(probe[2])}`);
    assert.equal(probe[3], -Infinity);
  } finally {
    session.close();
  }
});
