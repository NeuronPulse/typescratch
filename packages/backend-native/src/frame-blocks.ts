import type { BlockId, GraphBuilder, InputRef } from "@typescratch/graph";
import { FRAME_LIST_NAMES } from "@typescratch/runtime-abi";

export interface FrameRef {
  id: string;
  name: string;
}

export interface FrameLayout {
  nextFrameId: FrameRef;
  freeFrames: FrameRef;
  lists: Record<string, FrameRef>;
}

const SLOT_INITIAL: Record<string, string> = {
  "abi.frame.function": "0",
  "abi.frame.parent": "-1",
  "abi.frame.returnAddress": "",
  "abi.frame.returnTag": "",
  "abi.frame.returnValue": "0",
  "abi.frame.status": "running",
};

function literal(value: string): InputRef {
  return { primitive: [10, value] };
}

function numberLiteral(value: string): InputRef {
  return { primitive: [4, value] };
}

function variableRef(ref: FrameRef): InputRef {
  return { obscuredPrimitive: [12, ref.name, ref.id] };
}

function listField(ref: FrameRef): Record<string, [string, string]> {
  return { LIST: [ref.name, ref.id] };
}

function indexOf(builder: GraphBuilder, scope: string, token: InputRef): BlockId {
  const add = builder.add("operator_add", { scope });
  builder.input(add, "NUM1", token);
  builder.input(add, "NUM2", numberLiteral("1"));
  return add;
}

export function declareFrameLayout(builder: GraphBuilder): FrameLayout {
  const nextFrameId: FrameRef = { id: "v_abi_next_frame_id", name: "abi.nextFrameId" };
  builder.declareVariable(nextFrameId.id, nextFrameId.name, 0, "global");
  const freeFrames: FrameRef = { id: "l_abi_free_frames", name: "abi.freeFrames" };
  builder.declareList(freeFrames.id, freeFrames.name, [], "global");
  const lists: Record<string, FrameRef> = {};
  for (const name of FRAME_LIST_NAMES) {
    const entry: FrameRef = { id: `l_${name.replaceAll(".", "_")}`, name };
    builder.declareList(entry.id, entry.name, [], "global");
    lists[name] = entry;
  }
  return { nextFrameId, freeFrames, lists };
}

export function declareFrameToken(builder: GraphBuilder, script: number): FrameRef {
  const token: FrameRef = { id: `v_abi_token_${script}`, name: `abi.token.${script}` };
  builder.declareVariable(token.id, token.name, 0, "local");
  return token;
}

export function emitFrameAllocate(
  builder: GraphBuilder,
  scope: string,
  layout: FrameLayout,
  token: FrameRef,
): BlockId[] {
  const lengthBlock = builder.add("data_lengthoflist", { scope, fields: listField(layout.freeFrames) });
  const hasFree = builder.add("operator_gt", { scope });
  builder.input(hasFree, "OPERAND1", { block: lengthBlock });
  builder.input(hasFree, "OPERAND2", numberLiteral("0"));
  const branch = builder.add("control_if_else", { scope });
  builder.input(branch, "CONDITION", { block: hasFree });

  const item = builder.add("data_itemoflist", { scope, fields: listField(layout.freeFrames) });
  builder.input(item, "INDEX", literal("last"));
  const reuse = builder.add("data_setvariableto", {
    scope, fields: { VARIABLE: [token.name, token.id] as [string, string] },
  });
  builder.input(reuse, "VALUE", { block: item });
  const drop = builder.add("data_deleteoflist", { scope, fields: listField(layout.freeFrames) });
  builder.input(drop, "INDEX", literal("last"));
  builder.chain([reuse, drop]);
  builder.substack(branch, "SUBSTACK", reuse);

  const fresh = builder.add("data_setvariableto", {
    scope, fields: { VARIABLE: [token.name, token.id] as [string, string] },
  });
  builder.input(fresh, "VALUE", variableRef(layout.nextFrameId));
  const bump = builder.add("data_changevariableby", {
    scope, fields: { VARIABLE: [layout.nextFrameId.name, layout.nextFrameId.id] as [string, string] },
  });
  builder.input(bump, "VALUE", numberLiteral("1"));
  builder.chain([fresh, bump]);
  builder.substack(branch, "SUBSTACK2", fresh);

  return [branch];
}

export function emitFrameSlotAppend(
  builder: GraphBuilder,
  scope: string,
  layout: FrameLayout,
  token: FrameRef,
): BlockId[] {
  const probe = layout.lists["abi.frame.returnValue"]!;
  const lengthBlock = builder.add("data_lengthoflist", { scope, fields: listField(probe) });
  const recycled = builder.add("operator_lt", { scope });
  builder.input(recycled, "OPERAND1", variableRef(token));
  builder.input(recycled, "OPERAND2", { block: lengthBlock });
  const branch = builder.add("control_if_else", { scope });
  builder.input(branch, "CONDITION", { block: recycled });

  const reuseIds: BlockId[] = [];
  const appendIds: BlockId[] = [];
  for (const name of FRAME_LIST_NAMES) {
    const entry = layout.lists[name]!;
    const replace = builder.add("data_replaceitemoflist", { scope, fields: listField(entry) });
    builder.input(replace, "INDEX", { block: indexOf(builder, scope, variableRef(token)) });
    builder.input(replace, "ITEM", literal(SLOT_INITIAL[name] ?? ""));
    reuseIds.push(replace);

    const add = builder.add("data_addtolist", { scope, fields: listField(entry) });
    builder.input(add, "ITEM", literal(SLOT_INITIAL[name] ?? ""));
    appendIds.push(add);
  }
  builder.chain(reuseIds);
  builder.chain(appendIds);
  builder.substack(branch, "SUBSTACK", reuseIds[0]!);
  builder.substack(branch, "SUBSTACK2", appendIds[0]!);
  return [branch];
}

export function emitFrameReturnWrite(
  builder: GraphBuilder,
  scope: string,
  layout: FrameLayout,
  token: FrameRef,
  value: InputRef,
): BlockId[] {
  const list = layout.lists["abi.frame.returnValue"]!;
  const replace = builder.add("data_replaceitemoflist", { scope, fields: listField(list) });
  builder.input(replace, "INDEX", { block: indexOf(builder, scope, variableRef(token)) });
  builder.input(replace, "ITEM", value);
  return [replace];
}

export function emitFrameReturnRead(
  builder: GraphBuilder,
  scope: string,
  layout: FrameLayout,
  token: FrameRef,
): BlockId {
  const list = layout.lists["abi.frame.returnValue"]!;
  const item = builder.add("data_itemoflist", { scope, fields: listField(list) });
  builder.input(item, "INDEX", { block: indexOf(builder, scope, variableRef(token)) });
  return item;
}

export function emitFrameRelease(
  builder: GraphBuilder,
  scope: string,
  layout: FrameLayout,
  token: FrameRef,
): BlockId[] {
  const reference = variableRef(token);
  const status = layout.lists["abi.frame.status"]!;
  const replace = builder.add("data_replaceitemoflist", { scope, fields: listField(status) });
  builder.input(replace, "INDEX", { block: indexOf(builder, scope, reference) });
  builder.input(replace, "ITEM", literal("completed"));
  const free = builder.add("data_addtolist", { scope, fields: listField(layout.freeFrames) });
  builder.input(free, "ITEM", reference);
  return [replace, free];
}
