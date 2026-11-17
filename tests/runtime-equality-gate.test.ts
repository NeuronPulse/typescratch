import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder, defaultCostume, type Costume, type BlockId } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";

// Spike for the FIXED algorithm: gate (operator_equals) first; costumes only
// discriminate ASCII letter case; length mismatch fails immediately.
// Unsupported characters all land on the sentinel, which is safe here because
// the gate already rejected pairs whose only difference is NOT case.
const COSTUMES: Costume[] = ["__SENTINEL__", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("")]
  .map((name) => ({ ...defaultCostume(false), name }));
const OUT = "gateFixOut";

type Ref = { primitive: [4, string] } | { block: BlockId };

// [label, left, right, ECMAScript === expected, our algorithm's expected]
// The last column differs only for non-ASCII case folds (documented limit).
const CASES: [string, string, string, boolean, boolean][] = [
  ["ascii-case-differs", "A", "a", false, false],
  ["ascii-case-differs-mid", "AbC", "abc", false, false],
  ["ascii-same", "a", "a", true, true],
  ["ascii-same-mixed", "Hello", "Hello", true, true],
  ["empty", "", "", true, true],
  ["length-diff", "A", "AA", false, false],
  ["prefix", "Ab", "A", false, false],
  ["digits", "123", "123", true, true],
  ["space", "a b", "a b", true, true],
  ["numeric-looking", "10", "10.0", false, false],
  ["latin1-same", "é", "é", true, true],
  ["latin1-vs-cjk", "é", "中", false, false],
  ["cjk-same", "中", "中", true, true],
  ["emoji-same", "😀", "😀", true, true],
  ["emoji-differs", "😀", "😁", false, false],
  ["surrogate-lone", "\uD83D", "\uDE00", false, false],
  ["unsupported-vs-ascii", "é", "e", false, false],
  ["unsupported-in-longer", "aé", "ab", false, false],
  ["non-ascii-case-fold", "É", "é", false, true], // documented limitation
  ["greek-case-fold", "Σ", "σ", false, true], // documented limitation
];

function build(): { sb3: Uint8Array; blocks: number } {
  const builder = new GraphBuilder([
    { name: "Stage", isStage: true },
    { name: "Probe", isStage: false, costumes: COSTUMES },
  ]);
  builder.declareList(OUT, OUT, []);
  builder.declareVariable("gf_result", "gf_result", false, "local");
  builder.declareVariable("gf_idA", "gf_idA", 0, "local");
  builder.declareVariable("gf_idB", "gf_idB", 0, "local");
  const scope = "equality-gate-fix";
  const chain: BlockId[] = [builder.add("event_whenflagclicked", { scope, topLevel: true })];
  const add = (id: BlockId) => chain.push(id);

  const setVar = (name: string, value: Ref): BlockId => {
    const block = builder.add("data_setvariableto", { scope, fields: { VARIABLE: [name, name] } });
    builder.input(block, "VALUE", value);
    return block;
  };
  const readVar = (name: string): BlockId =>
    builder.add("data_variable", { scope, fields: { VARIABLE: [name, name] } });
  const letter = (text: string, index: number): BlockId => {
    const block = builder.add("operator_letter_of", { scope });
    builder.input(block, "LETTER", { primitive: [10, String(index)] });
    builder.input(block, "STRING", { primitive: [4, text] });
    return block;
  };
  const capture = (name: string, charRef: Ref): void => {
    const sentinel = builder.add("looks_switchcostumeto", { scope });
    builder.input(sentinel, "COSTUME", { primitive: [4, "__SENTINEL__"] });
    add(sentinel);
    const target = builder.add("looks_switchcostumeto", { scope });
    builder.input(target, "COSTUME", charRef);
    add(target);
    const number = builder.add("looks_costumenumbername", { scope, fields: { NUMBER_NAME: ["number", null] } });
    add(setVar(name, { block: number }));
  };
  const ifFalse = (condition: BlockId): void => {
    const ifBlock = builder.add("control_if", { scope });
    builder.input(ifBlock, "CONDITION", { block: condition });
    builder.substack(ifBlock, "SUBSTACK", setVar("gf_result", { primitive: [4, "false"] }));
    add(ifBlock);
  };

  for (const [, left, right] of CASES) {
    add(setVar("gf_result", { primitive: [4, "true"] }));

    // 1) gate: if !operator_equals(a,b) → false
    const gate = builder.add("operator_equals", { scope });
    builder.input(gate, "OPERAND1", { primitive: [4, left] });
    builder.input(gate, "OPERAND2", { primitive: [4, right] });
    const gateNot = builder.add("operator_not", { scope });
    builder.input(gateNot, "OPERAND", { block: gate });
    ifFalse(gateNot);

    // 2) length check: if length(a) != length(b) → false
    const lenA = builder.add("operator_length", { scope });
    builder.input(lenA, "STRING", { primitive: [4, left] });
    const lenB = builder.add("operator_length", { scope });
    builder.input(lenB, "STRING", { primitive: [4, right] });
    const lenEq = builder.add("operator_equals", { scope });
    builder.input(lenEq, "OPERAND1", { block: lenA });
    builder.input(lenEq, "OPERAND2", { block: lenB });
    const lenNot = builder.add("operator_not", { scope });
    builder.input(lenNot, "OPERAND", { block: lenEq });
    ifFalse(lenNot);

    // 3) per-character costume comparison (only reached when gate=true & same length)
    for (let i = 1; i <= left.length; i++) {
      capture("gf_idA", { block: letter(left, i) });
      capture("gf_idB", { block: letter(right, i) });
      const eq = builder.add("operator_equals", { scope });
      builder.input(eq, "OPERAND1", { block: readVar("gf_idA") });
      builder.input(eq, "OPERAND2", { block: readVar("gf_idB") });
      const not = builder.add("operator_not", { scope });
      builder.input(not, "OPERAND", { block: eq });
      ifFalse(not);
    }

    const pushResult = builder.add("data_addtolist", { scope, fields: { LIST: [OUT, OUT] } });
    builder.input(pushResult, "ITEM", { block: readVar("gf_result") });
    add(pushResult);
  }
  builder.chain(chain);
  const bag = new DiagnosticBag();
  const sb3 = exportSb3(builder.project, bag);
  assert.deepEqual(bag.items, [], JSON.stringify(bag.items));
  return { sb3, blocks: builder.blockCount };
}

test("FIXED SPIKE: gate + length + case-only costume comparison", async () => {
  const { sb3, blocks } = build();
  writeFileSync("dist/runtime-equality-gate-fix.sb3", sb3);
  console.log(`fix spike blocks=${blocks} costumes=${COSTUMES.length}`);
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 20000 && session.activeThreads() > 0; step++) session.step();
    const lists = session.lists();
    const results = Object.entries(lists).find(([, v]) => v.length === CASES.length)?.[1] ?? [];
    assert.equal(results.length, CASES.length, "every case must produce a result");
    const actual = results.map((v) => String(v) === "true");
    const algorithmExpected = CASES.map((c) => c[4]);
    const failures = CASES.map((c, i) => ({
      label: c[0], algorithmExpected: c[4], jsExpected: c[3], actual: actual[i],
    })).filter((r) => r.algorithmExpected !== r.actual);
    console.log("actual:", JSON.stringify(actual));
    console.log("algorithmExpected:", JSON.stringify(algorithmExpected));
    console.log("failures:", JSON.stringify(failures));
    // The algorithm must match its own contract exactly. Non-ASCII case folds
    // are the documented exception and are expected to differ from JS.
    assert.deepEqual(actual, algorithmExpected, "algorithm must match its documented contract");
  } finally {
    session.close();
  }
});
