import type { BlockId, GraphBuilder, InputRef, RoleDecl, Costume } from "@typescratch/graph";
import { defaultCostume } from "@typescratch/graph";

/**
 * Native case-sensitive string equality for statically-typed string operands.
 *
 * Scratch's `operator_equals` is case-insensitive. This helper uses costume
 * names — which ARE case-sensitive — to discriminate ASCII letter case only.
 * Everything else stays on `operator_equals` (the "gate"):
 *
 *   1. gate = operator_equals(a, b); if false, answer false.
 *   2. if length(a) != length(b), answer false (separates "10" from "10.0").
 *   3. per character, read costume number of each (switching through a
 *      sentinel so a failed switch cannot inherit a previous costume); if the
 *      numbers differ, answer false.
 *
 * Unsupported characters land on the sentinel. Safe because the gate already
 * rejected pairs differing in anything other than case. A gate-equal pair of
 * unsupported characters is either identical (both see the sentinel — true,
 * correct) or a non-ASCII case fold (É/é, Σ/σ) — a documented limitation.
 *
 * The comparison is INLINED as a statement sequence (not a custom procedure):
 * scratch-vm's procedure-call scheduling made a generated helper read stale
 * globals on consecutive comparisons. Inlined statements have no such issue
 * (proven by tests/runtime-equality-gate.test.ts). The sequence is emitted into
 * the enclosing statement's prelude, so it runs immediately before the read.
 */

const CASE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SENTINEL = "__SENTINEL__";
const IDX_ID = "v_abi_str_eq_index";
const IDX_NAME = "_tscr_sq_index";
const IDA_ID = "v_abi_str_eq_idA";
const IDA_NAME = "_tscr_sq_idA";
const IDB_ID = "v_abi_str_eq_idB";
const IDB_NAME = "_tscr_sq_idB";

export const HELPER_SPRITE_NAME = "__TScrStrEq";

export function stringEqHelperRole(): RoleDecl {
  const base = defaultCostume(false);
  const costumes: Costume[] = [SENTINEL, ...CASE_CHARS.split("")].map((name) => ({ ...base, name }));
  return { name: HELPER_SPRITE_NAME, isStage: false, costumes };
}

function varRef(id: string, name: string): InputRef {
  return { obscuredPrimitive: [12, name, id] };
}

function setVar(builder: GraphBuilder, scope: string, id: string, name: string, value: InputRef): BlockId {
  const block = builder.add("data_setvariableto", { scope, fields: { VARIABLE: [name, id] } });
  builder.input(block, "VALUE", value);
  return block;
}

function not(builder: GraphBuilder, scope: string, value: InputRef): InputRef {
  const id = builder.add("operator_not", { scope });
  builder.input(id, "OPERAND", value);
  return { block: id };
}

let eqCounter = 0;
export function resetStringEqCounter(): void {
  eqCounter = 0;
}

/** Declare the shared temporaries on the calling sprite (once). */
export function declareStringEqTemps(builder: GraphBuilder, scope: string): void {
  builder.declareVariable(IDX_ID, IDX_NAME, 0, "local");
  builder.declareVariable(IDA_ID, IDA_NAME, 0, "local");
  builder.declareVariable(IDB_ID, IDB_NAME, 0, "local");
}

/**
 * Emit an INLINED strict comparison into `prelude`, snapshot the boolean into
 * a fresh local, and return a reporter reading that snapshot.
 */
export function emitStringEqInline(
  builder: GraphBuilder,
  prelude: BlockId[],
  left: InputRef,
  right: InputRef,
  negate: boolean,
): InputRef {
  const index = ++eqCounter;
  const resultId = `v_abi_str_eq_res_${index}`;
  const resultName = `_tscr_sq_res${index}`;
  builder.declareVariable(resultId, resultName, false, "local");
  const scope = "string-eq-inline";
  const FALSE = { primitive: [4, "false"] } as InputRef;
  const TRUE = { primitive: [4, "true"] } as InputRef;
  const snapshot = negate ? FALSE : TRUE;
  const opposite = negate ? TRUE : FALSE;

  prelude.push(setVar(builder, scope, resultId, resultName, snapshot));
  const flip = (cond: InputRef): void => {
    const branch = builder.add("control_if", { scope });
    builder.input(branch, "CONDITION", not(builder, scope, cond));
    builder.substack(branch, "SUBSTACK", setVar(builder, scope, resultId, resultName, opposite));
    prelude.push(branch);
  };

  // left/right are reporters already emitted by the caller; snapshot them into
  // locals so the (destructive) costume probe cannot change their source.
  const aId = `v_abi_str_eq_a_${index}`;
  const bId = `v_abi_str_eq_b_${index}`;
  const aName = `_tscr_sq_a${index}`;
  const bName = `_tscr_sq_b${index}`;
  builder.declareVariable(aId, aName, "", "local");
  builder.declareVariable(bId, bName, "", "local");
  prelude.push(setVar(builder, scope, aId, aName, left));
  prelude.push(setVar(builder, scope, bId, bName, right));
  const A = (): InputRef => varRef(aId, aName);
  const B = (): InputRef => varRef(bId, bName);

  // 1) gate
  const gate = builder.add("operator_equals", { scope });
  builder.input(gate, "OPERAND1", A());
  builder.input(gate, "OPERAND2", B());
  flip({ block: gate });

  // 2) length check
  const lenA = builder.add("operator_length", { scope });
  builder.input(lenA, "STRING", A());
  const lenB = builder.add("operator_length", { scope });
  builder.input(lenB, "STRING", B());
  const lenEq = builder.add("operator_equals", { scope });
  builder.input(lenEq, "OPERAND1", { block: lenA });
  builder.input(lenEq, "OPERAND2", { block: lenB });
  flip({ block: lenEq });

  // 3) per-character loop: repeat(length(a))
  // Reset the shared index before every comparison: consecutive comparisons
  // otherwise start at the previous loop's final index.
  prelude.push(setVar(builder, scope, IDX_ID, IDX_NAME, { primitive: [4, "0"] }));
  const repeat = builder.add("control_repeat", { scope });
  const loopLen = builder.add("operator_length", { scope, parent: repeat });
  builder.input(loopLen, "STRING", A());
  builder.input(repeat, "TIMES", { block: loopLen });
  const loop: BlockId[] = [];
  const inc = builder.add("operator_add", { scope });
  builder.input(inc, "NUM1", varRef(IDX_ID, IDX_NAME));
  builder.input(inc, "NUM2", { primitive: [4, "1"] });
  loop.push(setVar(builder, scope, IDX_ID, IDX_NAME, { block: inc }));
  const capture = (id: string, name: string, text: InputRef): void => {
    const toSentinel = builder.add("looks_switchcostumeto", { scope });
    builder.input(toSentinel, "COSTUME", { primitive: [4, SENTINEL] });
    loop.push(toSentinel);
    const letter = builder.add("operator_letter_of", { scope });
    builder.input(letter, "LETTER", varRef(IDX_ID, IDX_NAME));
    builder.input(letter, "STRING", text);
    const toChar = builder.add("looks_switchcostumeto", { scope });
    builder.input(toChar, "COSTUME", { block: letter });
    loop.push(toChar);
    const number = builder.add("looks_costumenumbername", { scope, fields: { NUMBER_NAME: ["number", null] } });
    loop.push(setVar(builder, scope, id, name, { block: number }));
  };
  capture(IDA_ID, IDA_NAME, A());
  capture(IDB_ID, IDB_NAME, B());
  const idEq = builder.add("operator_equals", { scope });
  builder.input(idEq, "OPERAND1", varRef(IDA_ID, IDA_NAME));
  builder.input(idEq, "OPERAND2", varRef(IDB_ID, IDB_NAME));
  const loopFlip = builder.add("control_if", { scope });
  builder.input(loopFlip, "CONDITION", not(builder, scope, { block: idEq }));
  builder.substack(loopFlip, "SUBSTACK", setVar(builder, scope, resultId, resultName, opposite));
  loop.push(loopFlip);
  builder.chain(loop);
  builder.substack(repeat, "SUBSTACK", loop[0]!);
  prelude.push(repeat);

  return varRef(resultId, resultName);
}
