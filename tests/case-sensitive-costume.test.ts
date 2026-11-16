import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder, defaultCostume, type Costume, type BlockId } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ";
const COSTUMES: Costume[] = ["__SENTINEL__", ...CHARS.split("")].map((name) => ({ ...defaultCostume(false), name }));
const OUT = "caseProbeOut";

const CASES: [string, string, boolean][] = [
  ["A", "a", false],
  ["a", "a", true],
  ["HELLO", "hello", false],
  ["Hello", "Hello", true],
  ["", "", true],
  ["AbC", "Abc", false],
  ["123", "123", true],
  ["a b", "a b", true],
];

function build(): { sb3: Uint8Array; blocks: number } {
  const builder = new GraphBuilder([
    { name: "Stage", isStage: true },
    { name: "Probe", isStage: false, costumes: COSTUMES },
  ]);
  builder.declareList(OUT, OUT, []);
  builder.declareVariable("cp_result", "cp_result", false, "local");
  builder.declareVariable("cp_idA", "cp_idA", 0, "local");
  builder.declareVariable("cp_idB", "cp_idB", 0, "local");
  const scope = "case-poc";
  const chain: BlockId[] = [builder.add("event_whenflagclicked", { scope, topLevel: true })];
  const add = (id: BlockId) => chain.push(id);

  type Ref = { primitive: [4, string] } | { block: BlockId };
  const setVar = (name: string, value: Ref): BlockId => {
    const block = builder.add("data_setvariableto", { scope, fields: { VARIABLE: [name, name] } });
    builder.input(block, "VALUE", value);
    return block;
  };
  const readVar = (name: string): BlockId =>
    builder.add("data_variable", { scope, fields: { VARIABLE: [name, name] } });
  const switchTo = (ref: Ref): BlockId[] => {
    const sentinel = builder.add("looks_switchcostumeto", { scope });
    builder.input(sentinel, "COSTUME", { primitive: [4, "__SENTINEL__"] });
    const target = builder.add("looks_switchcostumeto", { scope });
    builder.input(target, "COSTUME", ref);
    return [sentinel, target];
  };
  const capture = (name: string, charRef: Ref): void => {
    for (const id of switchTo(charRef)) add(id);
    const number = builder.add("looks_costumenumbername", { scope, fields: { NUMBER_NAME: ["number", null] } });
    add(setVar(name, { block: number }));
  };
  const letter = (text: string, index: number): BlockId => {
    const block = builder.add("operator_letter_of", { scope });
    builder.input(block, "LETTER", { primitive: [10, String(index)] });
    builder.input(block, "STRING", { primitive: [4, text] });
    return block;
  };

  for (const [left, right] of CASES) {
    add(setVar("cp_result", { primitive: [4, "true"] }));
    if (left.length !== right.length) {
      add(setVar("cp_result", { primitive: [4, "false"] }));
    } else {
      for (let i = 1; i <= left.length; i++) {
        capture("cp_idA", { block: letter(left, i) });
        capture("cp_idB", { block: letter(right, i) });
        const eq = builder.add("operator_equals", { scope });
        builder.input(eq, "OPERAND1", { block: readVar("cp_idA") });
        builder.input(eq, "OPERAND2", { block: readVar("cp_idB") });
        const not = builder.add("operator_not", { scope });
        builder.input(not, "OPERAND", { block: eq });
        const ifBlock = builder.add("control_if", { scope });
        builder.input(ifBlock, "CONDITION", { block: not });
        builder.substack(ifBlock, "SUBSTACK", setVar("cp_result", { primitive: [4, "false"] }));
        add(ifBlock);
      }
    }
    const push = builder.add("data_addtolist", { scope, fields: { LIST: [OUT, OUT] } });
    builder.input(push, "ITEM", { block: readVar("cp_result") });
    add(push);
  }
  builder.chain(chain);
  const bag = new DiagnosticBag();
  const sb3 = exportSb3(builder.project, bag);
  assert.deepEqual(bag.items, [], JSON.stringify(bag.items));
  return { sb3, blocks: builder.blockCount };
}

test("costume-identity case-sensitive string equality PoC", async () => {
  const { sb3, blocks } = build();
  writeFileSync("dist/case-sensitive-poc.sb3", sb3);
  console.log(`PoC blocks=${blocks} costumes=${COSTUMES.length}`);
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 1000 && session.activeThreads() > 0; step++) session.step();
    const list = Object.values(session.lists()).find((values) => values.length === CASES.length) ?? [];
    const actual = list.map((value) => String(value) === "true");
    const expected = CASES.map((entry) => entry[2]);
    console.log("actual:", JSON.stringify(actual), "expected:", JSON.stringify(expected));
    assert.deepEqual(actual, expected);
  } finally {
    session.close();
  }
});
