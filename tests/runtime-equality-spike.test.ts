import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder, defaultCostume, type Costume, type BlockId } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession } from "@typescratch/testing";

// === SPIKE ASSET — NOT A SEMANTIC GATE. DO NOT WIRE INTO PRODUCTION LOWERING. ===
// Question: can costume-name identity implement ECMAScript string equality for
// ARBITRARY TypeScript string, including characters with no matching costume?
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ";
const COSTUMES: Costume[] = ["__SENTINEL__", ...CHARS.split("")].map((name) => ({ ...defaultCostume(false), name }));
const OUT = "spikeOut";
const IDS = "spikeIds";

// [label, left, right, ECMAScript expected]
const CASES: [string, string, string, boolean][] = [
  ["ascii-case-differs", "A", "a", false],
  ["ascii-same", "a", "a", true],
  ["empty", "", "", true],
  ["length-diff", "A", "AA", false],
  ["prefix", "Ab", "A", false],
  ["digits", "123", "123", true],
  ["space", "a b", "a b", true],
  // Unsupported characters: the critical false-positive risk.
  ["latin1-same", "é", "é", true],
  ["latin1-vs-cjk", "é", "中", false],
  ["cjk-same", "中", "中", true],
  ["emoji-same", "😀", "😀", true],
  ["emoji-differs", "😀", "😁", false],
  ["surrogate-lone", "\uD83D", "\uDE00", false],
  ["unsupported-vs-ascii", "é", "e", false],
  ["unsupported-in-longer", "aé", "ab", false],
];

type Ref = { primitive: [4, string] } | { block: BlockId };

function build(): { sb3: Uint8Array; blocks: number } {
  const builder = new GraphBuilder([
    { name: "Stage", isStage: true },
    { name: "Probe", isStage: false, costumes: COSTUMES },
  ]);
  builder.declareList(OUT, OUT, []);
  builder.declareList(IDS, IDS, []);
  builder.declareVariable("cp_result", "cp_result", false, "local");
  builder.declareVariable("cp_idA", "cp_idA", 0, "local");
  builder.declareVariable("cp_idB", "cp_idB", 0, "local");
  const scope = "equality-spike";
  const chain: BlockId[] = [builder.add("event_whenflagclicked", { scope, topLevel: true })];
  const add = (id: BlockId) => chain.push(id);

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

  for (const [, left, right] of CASES) {
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
    const pushResult = builder.add("data_addtolist", { scope, fields: { LIST: [OUT, OUT] } });
    builder.input(pushResult, "ITEM", { block: readVar("cp_result") });
    add(pushResult);
    const pushIds = builder.add("data_addtolist", { scope, fields: { LIST: [IDS, IDS] } });
    builder.input(pushIds, "ITEM", { primitive: [4, `${left.charCodeAt(0)}-${right.charCodeAt(0)}=${left.charCodeAt(0) === right.charCodeAt(0)}`] });
    add(pushIds);
  }
  builder.chain(chain);
  const bag = new DiagnosticBag();
  const sb3 = exportSb3(builder.project, bag);
  assert.deepEqual(bag.items, [], JSON.stringify(bag.items));
  return { sb3, blocks: builder.blockCount };
}

test("SPIKE: costume identity fails closed on unsupported characters", async () => {
  const { sb3, blocks } = build();
  writeFileSync("dist/runtime-equality-spike.sb3", sb3);
  console.log(`spike blocks=${blocks} costumes=${COSTUMES.length}`);
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 5000 && session.activeThreads() > 0; step++) session.step();
    const lists = session.lists();
    const results = Object.entries(lists).find(([, v]) => v.length === CASES.length)?.[1] ?? [];
    const actual = results.map((v) => String(v) === "true");
    const expected = CASES.map((c) => c[3]);
    const failures = CASES.map((c, i) => ({ label: c[0], expected: c[3], actual: actual[i] })).filter((r) => r.expected !== r.actual);
    console.log("cases:", JSON.stringify(CASES.map((c) => c[0])));
    console.log("actual:", JSON.stringify(actual));
    console.log("expected:", JSON.stringify(expected));
    console.log("failures:", JSON.stringify(failures));
    // This is a spike: we RECORD behavior, not assert the desired behavior.
    assert.equal(results.length, CASES.length, "every case must produce a result");
  } finally {
    session.close();
  }
});

// Two green-flag scripts share ONE Probe sprite. Each uses private variables
// and appends to its own list, but costume state is global to the sprite.
// 40 interleaved ASCII-only comparisons each; if the mechanism is atomic the
// results must be identical to the single-thread case.
function buildConcurrent(): Uint8Array {
  const builder = new GraphBuilder([
    { name: "Stage", isStage: true },
    { name: "Probe", isStage: false, costumes: COSTUMES },
  ]);
  builder.declareList("listA", "listA", []);
  builder.declareList("listB", "listB", []);
  const scope = "equality-spike-concurrent";

  const setVar = (suffix: string, name: string, value: Ref): BlockId => {
    const block = builder.add("data_setvariableto", { scope, fields: { VARIABLE: [name + suffix, name + suffix] } });
    builder.input(block, "VALUE", value);
    return block;
  };
  const readVar = (name: string): BlockId => builder.add("data_variable", { scope, fields: { VARIABLE: [name, name] } });
  const letter = (text: string, index: number): BlockId => {
    const block = builder.add("operator_letter_of", { scope });
    builder.input(block, "LETTER", { primitive: [10, String(index)] });
    builder.input(block, "STRING", { primitive: [4, text] });
    return block;
  };

  const script = (suffix: string, pairs: [string, string][], listName: string): void => {
    builder.declareVariable("cp_result" + suffix, "cp_result" + suffix, false, "local");
    builder.declareVariable("cp_idA" + suffix, "cp_idA" + suffix, 0, "local");
    builder.declareVariable("cp_idB" + suffix, "cp_idB" + suffix, 0, "local");
    const chain: BlockId[] = [builder.add("event_whenflagclicked", { scope, topLevel: true })];
    const add = (id: BlockId) => chain.push(id);
    const capture = (name: string, charRef: Ref): void => {
      const sentinel = builder.add("looks_switchcostumeto", { scope });
      builder.input(sentinel, "COSTUME", { primitive: [4, "__SENTINEL__"] });
      add(sentinel);
      const target = builder.add("looks_switchcostumeto", { scope });
      builder.input(target, "COSTUME", charRef);
      add(target);
      const number = builder.add("looks_costumenumbername", { scope, fields: { NUMBER_NAME: ["number", null] } });
      add(setVar(suffix, name, { block: number }));
    };
    for (const [left, right] of pairs) {
      add(setVar(suffix, "cp_result", { primitive: [4, "true"] }));
      for (let i = 1; i <= left.length; i++) {
        capture("cp_idA", { block: letter(left, i) });
        capture("cp_idB", { block: letter(right, i) });
        const eq = builder.add("operator_equals", { scope });
        builder.input(eq, "OPERAND1", { block: readVar("cp_idA" + suffix) });
        builder.input(eq, "OPERAND2", { block: readVar("cp_idB" + suffix) });
        const not = builder.add("operator_not", { scope });
        builder.input(not, "OPERAND", { block: eq });
        const ifBlock = builder.add("control_if", { scope });
        builder.input(ifBlock, "CONDITION", { block: not });
        builder.substack(ifBlock, "SUBSTACK", setVar(suffix, "cp_result", { primitive: [4, "false"] }));
        add(ifBlock);
      }
      const push = builder.add("data_addtolist", { scope, fields: { LIST: [listName, listName] } });
      builder.input(push, "ITEM", { block: readVar("cp_result" + suffix) });
      add(push);
    }
    builder.chain(chain);
  };

  // A compares unequal ASCII pairs (always false); B compares identical pairs
  // (always true). Interleaving thread steps must not change either answer.
  const pairA: [string, string][] = Array.from({ length: 40 }, () => ["A", "a"]);
  const pairB: [string, string][] = Array.from({ length: 40 }, () => ["Zz9", "Zz9"]);
  script("A", pairA, "listA");
  script("B", pairB, "listB");
  const bag = new DiagnosticBag();
  const sb3 = exportSb3(builder.project, bag);
  assert.deepEqual(bag.items, [], JSON.stringify(bag.items));
  return sb3;
}

test("SPIKE: two concurrent green-flag scripts sharing the helper sprite", async () => {
  const sb3 = buildConcurrent();
  writeFileSync("dist/runtime-equality-spike-concurrent.sb3", sb3);
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    for (let step = 0; step < 20000 && session.activeThreads() > 0; step++) session.step();
    const lists = session.lists();
    console.log("list keys:", JSON.stringify(Object.keys(lists)), "sizes:", JSON.stringify(Object.values(lists).map((v) => v.length)));
    const all = Object.values(lists);
    const a = all[0] ?? [];
    const b = all[1] ?? [];
    const aWrong = a.filter((v) => String(v) !== "false").length;
    const bWrong = b.filter((v) => String(v) !== "true").length;
    console.log(`concurrent: A=${a.length} results, ${aWrong} wrong; B=${b.length} results, ${bWrong} wrong`);
    console.log("A sample:", JSON.stringify(a.slice(0, 10)));
    console.log("B sample:", JSON.stringify(b.slice(0, 10)));
    assert.equal(a.length, 40, "script A must finish all comparisons");
    assert.equal(b.length, 40, "script B must finish all comparisons");
  } finally {
    session.close();
  }
});
