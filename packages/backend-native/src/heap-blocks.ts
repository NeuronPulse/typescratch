import type { BlockId, GraphBuilder, InputRef } from "@typescratch/graph";
import {
  ARRAY_CLASS,
  HEAP_ARRAY_FREE_SIZE,
  HEAP_ARRAY_FREE_START,
  HEAP_ARRAY_ITEMS,
  HEAP_ARRAY_LENGTH,
  HEAP_ARRAY_START,
  HEAP_CLASS_LIST,
  HEAP_FREE_LIST,
  HEAP_NEXT_ID,
  HEAP_STATUS_LIST,
  heapFieldList,
  heapParallelLists,
} from "@typescratch/runtime-abi";

export interface HeapRef {
  id: string;
  name: string;
}

export interface HeapLayout {
  nextObjectId: HeapRef;
  freeObjects: HeapRef;
  classId: HeapRef;
  status: HeapRef;
  arrayStart: HeapRef;
  arrayLength: HeapRef;
  arrayItems: HeapRef;
  freeStart: HeapRef;
  freeSize: HeapRef;
  reuseStart: HeapRef;
  reuseSize: HeapRef;
  parallel: HeapRef[];
  fields: Record<string, HeapRef>;
  initial: Record<string, string>;
}

const FIELD_PREFIX = heapFieldList("");

const literal = (value: string): InputRef => ({ primitive: [10, value] });
const numberLiteral = (value: string): InputRef => ({ primitive: [4, value] });
const variableRef = (ref: HeapRef): InputRef => ({ obscuredPrimitive: [12, ref.name, ref.id] });
const listField = (ref: HeapRef): Record<string, [string, string]> => ({ LIST: [ref.name, ref.id] });
const variableField = (ref: HeapRef): Record<string, [string, string]> => ({
  VARIABLE: [ref.name, ref.id],
});

function oneBased(builder: GraphBuilder, scope: string, token: InputRef): BlockId {
  const add = builder.add("operator_add", { scope });
  builder.input(add, "NUM1", token);
  builder.input(add, "NUM2", numberLiteral("1"));
  return add;
}

function slotValue(
  layout: HeapLayout,
  entry: HeapRef,
  classId: string,
  fieldValues: Record<string, InputRef>,
): InputRef {
  if (entry.name === HEAP_CLASS_LIST) return literal(classId);
  if (entry.name.startsWith(FIELD_PREFIX)) {
    const field = entry.name.slice(FIELD_PREFIX.length);
    if (fieldValues[field]) return fieldValues[field]!;
  }
  return literal(layout.initial[entry.name] ?? "0");
}

/** All heap lists live on the Stage so every role sees the same object ids. */
export function declareHeapLayout(
  builder: GraphBuilder,
  fieldNames: readonly string[],
  fieldInitials: Record<string, string> = {},
): HeapLayout {
  const nextObjectId: HeapRef = { id: "v_heap_next_object_id", name: HEAP_NEXT_ID };
  builder.declareVariable(nextObjectId.id, nextObjectId.name, 0, "global");
  const freeObjects: HeapRef = { id: "l_heap_free_objects", name: HEAP_FREE_LIST };
  builder.declareList(freeObjects.id, freeObjects.name, [], "global");
  const arrayItems: HeapRef = { id: "l_heap_array_items", name: HEAP_ARRAY_ITEMS };
  builder.declareList(arrayItems.id, arrayItems.name, [], "global");
  const freeStart: HeapRef = { id: "l_heap_array_free_start", name: HEAP_ARRAY_FREE_START };
  builder.declareList(freeStart.id, freeStart.name, [], "global");
  const freeSize: HeapRef = { id: "l_heap_array_free_size", name: HEAP_ARRAY_FREE_SIZE };
  builder.declareList(freeSize.id, freeSize.name, [], "global");
  const reuseStart: HeapRef = { id: "v_heap_array_reuse_start", name: "heap.array.reuseStart" };
  builder.declareVariable(reuseStart.id, reuseStart.name, 0, "global");
  const reuseSize: HeapRef = { id: "v_heap_array_reuse_size", name: "heap.array.reuseSize" };
  builder.declareVariable(reuseSize.id, reuseSize.name, 0, "global");

  const byName: Record<string, HeapRef> = {};
  const initial: Record<string, string> = {};
  const parallel: HeapRef[] = [];
  for (const name of heapParallelLists(fieldNames)) {
    const ref: HeapRef = { id: `l_${name.replaceAll(".", "_")}`, name };
    builder.declareList(ref.id, ref.name, [], "global");
    byName[name] = ref;
    parallel.push(ref);
    if (name === HEAP_CLASS_LIST) initial[name] = "";
    else if (name === HEAP_STATUS_LIST) initial[name] = "live";
    else if (name === HEAP_ARRAY_START || name === HEAP_ARRAY_LENGTH) initial[name] = "0";
    else initial[name] = fieldInitials[name.slice(FIELD_PREFIX.length)] ?? "0";
  }
  const fields: Record<string, HeapRef> = {};
  for (const field of fieldNames) fields[field] = byName[heapFieldList(field)]!;
  return {
    nextObjectId,
    freeObjects,
    classId: byName[HEAP_CLASS_LIST]!,
    status: byName[HEAP_STATUS_LIST]!,
    arrayStart: byName[HEAP_ARRAY_START]!,
    arrayLength: byName[HEAP_ARRAY_LENGTH]!,
    arrayItems,
    freeStart,
    freeSize,
    reuseStart,
    reuseSize,
    parallel,
    fields,
    initial,
  };
}

export function emitHeapObjectId(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  token: HeapRef,
): BlockId[] {
  const lengthBlock = builder.add("data_lengthoflist", { scope, fields: listField(layout.freeObjects) });
  const hasFree = builder.add("operator_gt", { scope });
  builder.input(hasFree, "OPERAND1", { block: lengthBlock });
  builder.input(hasFree, "OPERAND2", numberLiteral("0"));
  const branch = builder.add("control_if_else", { scope });
  builder.input(branch, "CONDITION", { block: hasFree });

  const item = builder.add("data_itemoflist", { scope, fields: listField(layout.freeObjects) });
  builder.input(item, "INDEX", literal("last"));
  const reuse = builder.add("data_setvariableto", { scope, fields: variableField(token) });
  builder.input(reuse, "VALUE", { block: item });
  const drop = builder.add("data_deleteoflist", { scope, fields: listField(layout.freeObjects) });
  builder.input(drop, "INDEX", literal("last"));
  builder.chain([reuse, drop]);
  builder.substack(branch, "SUBSTACK", reuse);

  const fresh = builder.add("data_setvariableto", { scope, fields: variableField(token) });
  builder.input(fresh, "VALUE", variableRef(layout.nextObjectId));
  const bump = builder.add("data_changevariableby", {
    scope,
    fields: variableField(layout.nextObjectId),
  });
  builder.input(bump, "VALUE", numberLiteral("1"));
  builder.chain([fresh, bump]);
  builder.substack(branch, "SUBSTACK2", fresh);
  return [branch];
}

export function emitHeapSlot(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  token: HeapRef,
  classId: string,
  fieldValues: Record<string, InputRef> = {},
): BlockId[] {
  const lengthBlock = builder.add("data_lengthoflist", { scope, fields: listField(layout.classId) });
  const recycled = builder.add("operator_lt", { scope });
  builder.input(recycled, "OPERAND1", variableRef(token));
  builder.input(recycled, "OPERAND2", { block: lengthBlock });
  const branch = builder.add("control_if_else", { scope });
  builder.input(branch, "CONDITION", { block: recycled });

  const reuseIds: BlockId[] = [];
  const appendIds: BlockId[] = [];
  for (const entry of layout.parallel) {
    const value = slotValue(layout, entry, classId, fieldValues);
    const replace = builder.add("data_replaceitemoflist", { scope, fields: listField(entry) });
    builder.input(replace, "INDEX", { block: oneBased(builder, scope, variableRef(token)) });
    builder.input(replace, "ITEM", value);
    reuseIds.push(replace);
    const add = builder.add("data_addtolist", { scope, fields: listField(entry) });
    builder.input(add, "ITEM", value);
    appendIds.push(add);
  }
  builder.chain(reuseIds);
  builder.chain(appendIds);
  builder.substack(branch, "SUBSTACK", reuseIds[0]!);
  builder.substack(branch, "SUBSTACK2", appendIds[0]!);
  return [branch];
}

export function emitHeapAllocate(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  token: HeapRef,
  classId: string,
  fieldValues: Record<string, InputRef> = {},
): BlockId[] {
  return [
    ...emitHeapObjectId(builder, scope, layout, token),
    ...emitHeapSlot(builder, scope, layout, token, classId, fieldValues),
  ];
}

/**
 * Array sizes are compile-time constants, so both branches are fixed, unbranched
 * with respect to yields. A freed interval is reused (and split) when the last
 * interval is large enough; otherwise new items are appended.
 */
export function emitHeapArrayAllocate(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  token: HeapRef,
  size: number,
  fieldValues: Record<string, InputRef> = {},
): BlockId[] {
  const ids = emitHeapAllocate(builder, scope, layout, token, ARRAY_CLASS, fieldValues);
  const index = (): BlockId => oneBased(builder, scope, variableRef(token));
  const lengthItems = (): BlockId =>
    builder.add("data_lengthoflist", { scope, fields: listField(layout.arrayItems) });
  const writeSlot = (list: HeapRef, value: InputRef): BlockId => {
    const write = builder.add("data_replaceitemoflist", { scope, fields: listField(list) });
    builder.input(write, "INDEX", { block: index() });
    builder.input(write, "ITEM", value);
    return write;
  };
  const appendIds: BlockId[] = [
    writeSlot(layout.arrayStart, { block: lengthItems() }),
    writeSlot(layout.arrayLength, numberLiteral(String(size))),
  ];
  for (let position = 0; position < size; position++) {
    const fill = builder.add("data_addtolist", { scope, fields: listField(layout.arrayItems) });
    builder.input(fill, "ITEM", numberLiteral("0"));
    appendIds.push(fill);
  }
  if (size <= 0) return [...ids, ...appendIds];

  const freeCount = builder.add("data_lengthoflist", { scope, fields: listField(layout.freeSize) });
  const hasAny = builder.add("operator_gt", { scope });
  builder.input(hasAny, "OPERAND1", { block: freeCount });
  builder.input(hasAny, "OPERAND2", numberLiteral("0"));
  const lastSize = builder.add("data_itemoflist", { scope, fields: listField(layout.freeSize) });
  builder.input(lastSize, "INDEX", literal("last"));
  const fits = builder.add("operator_gt", { scope });
  builder.input(fits, "OPERAND1", { block: lastSize });
  builder.input(fits, "OPERAND2", numberLiteral(String(size - 1)));
  const canReuse = builder.add("operator_and", { scope });
  builder.input(canReuse, "OPERAND1", { block: hasAny });
  builder.input(canReuse, "OPERAND2", { block: fits });
  const branch = builder.add("control_if_else", { scope });
  builder.input(branch, "CONDITION", { block: canReuse });

  const remember = (list: HeapRef, target: HeapRef): BlockId => {
    const item = builder.add("data_itemoflist", { scope, fields: listField(list) });
    builder.input(item, "INDEX", literal("last"));
    const set = builder.add("data_setvariableto", { scope, fields: variableField(target) });
    builder.input(set, "VALUE", { block: item });
    return set;
  };
  const dropLast = (list: HeapRef): BlockId => {
    const drop = builder.add("data_deleteoflist", { scope, fields: listField(list) });
    builder.input(drop, "INDEX", literal("last"));
    return drop;
  };
  const reuseIds: BlockId[] = [
    remember(layout.freeStart, layout.reuseStart),
    remember(layout.freeSize, layout.reuseSize),
    dropLast(layout.freeStart),
    dropLast(layout.freeSize),
  ];

  const bigger = builder.add("operator_gt", { scope });
  builder.input(bigger, "OPERAND1", variableRef(layout.reuseSize));
  builder.input(bigger, "OPERAND2", numberLiteral(String(size)));
  const split = builder.add("control_if", { scope });
  builder.input(split, "CONDITION", { block: bigger });
  const tailStart = builder.add("operator_add", { scope });
  builder.input(tailStart, "NUM1", variableRef(layout.reuseStart));
  builder.input(tailStart, "NUM2", numberLiteral(String(size)));
  const addStart = builder.add("data_addtolist", { scope, fields: listField(layout.freeStart) });
  builder.input(addStart, "ITEM", { block: tailStart });
  const tailSize = builder.add("operator_subtract", { scope });
  builder.input(tailSize, "NUM1", variableRef(layout.reuseSize));
  builder.input(tailSize, "NUM2", numberLiteral(String(size)));
  const addSize = builder.add("data_addtolist", { scope, fields: listField(layout.freeSize) });
  builder.input(addSize, "ITEM", { block: tailSize });
  builder.chain([addStart, addSize]);
  builder.substack(split, "SUBSTACK", addStart);
  reuseIds.push(split);

  reuseIds.push(writeSlot(layout.arrayStart, variableRef(layout.reuseStart)));
  reuseIds.push(writeSlot(layout.arrayLength, numberLiteral(String(size))));
  for (let position = 0; position < size; position++) {
    const at = builder.add("operator_add", { scope });
    builder.input(at, "NUM1", variableRef(layout.reuseStart));
    builder.input(at, "NUM2", numberLiteral(String(position + 1)));
    const clear = builder.add("data_replaceitemoflist", { scope, fields: listField(layout.arrayItems) });
    builder.input(clear, "INDEX", { block: at });
    builder.input(clear, "ITEM", numberLiteral("0"));
    reuseIds.push(clear);
  }

  builder.chain(reuseIds);
  builder.chain(appendIds);
  builder.substack(branch, "SUBSTACK", reuseIds[0]!);
  builder.substack(branch, "SUBSTACK2", appendIds[0]!);
  return [...ids, branch];
}

export function emitHeapFieldRead(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  object: InputRef,
  field: string,
): BlockId {
  const item = builder.add("data_itemoflist", { scope, fields: listField(layout.fields[field]!) });
  builder.input(item, "INDEX", { block: oneBased(builder, scope, object) });
  return item;
}

export function emitHeapFieldWrite(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  object: InputRef,
  field: string,
  value: InputRef,
): BlockId {
  const write = builder.add("data_replaceitemoflist", { scope, fields: listField(layout.fields[field]!) });
  builder.input(write, "INDEX", { block: oneBased(builder, scope, object) });
  builder.input(write, "ITEM", value);
  return write;
}

export function emitHeapClassOf(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  object: InputRef,
): BlockId {
  const item = builder.add("data_itemoflist", { scope, fields: listField(layout.classId) });
  builder.input(item, "INDEX", { block: oneBased(builder, scope, object) });
  return item;
}

export function emitHeapArrayLength(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  array: InputRef,
): BlockId {
  const item = builder.add("data_itemoflist", { scope, fields: listField(layout.arrayLength) });
  builder.input(item, "INDEX", { block: oneBased(builder, scope, array) });
  return item;
}

function arrayPosition(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  array: InputRef,
  index: InputRef,
): BlockId {
  const start = builder.add("data_itemoflist", { scope, fields: listField(layout.arrayStart) });
  builder.input(start, "INDEX", { block: oneBased(builder, scope, array) });
  const offset = builder.add("operator_add", { scope });
  builder.input(offset, "NUM1", { block: start });
  builder.input(offset, "NUM2", index);
  const position = builder.add("operator_add", { scope });
  builder.input(position, "NUM1", { block: offset });
  builder.input(position, "NUM2", numberLiteral("1"));
  return position;
}

export function emitHeapArrayRead(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  array: InputRef,
  index: InputRef,
): BlockId {
  const item = builder.add("data_itemoflist", { scope, fields: listField(layout.arrayItems) });
  builder.input(item, "INDEX", {
    block: arrayPosition(builder, scope, layout, array, index),
  });
  return item;
}

export function emitHeapArrayWrite(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  array: InputRef,
  index: InputRef,
  value: InputRef,
): BlockId {
  const write = builder.add("data_replaceitemoflist", { scope, fields: listField(layout.arrayItems) });
  builder.input(write, "INDEX", {
    block: arrayPosition(builder, scope, layout, array, index),
  });
  builder.input(write, "ITEM", value);
  return write;
}

/**
 * Releases an ObjectRef: tombstones the slot, registers its array range in the
 * free-interval lists and returns the id to the object free list. Any release
 * order is correct — no range is shifted. `object` must be a plain variable ref
 * so it can be read several times without reparenting a block.
 */
export function emitHeapRelease(
  builder: GraphBuilder,
  scope: string,
  layout: HeapLayout,
  object: InputRef,
  arraySize?: number,
): BlockId[] {
  const ids: BlockId[] = [];
  const status = builder.add("data_replaceitemoflist", { scope, fields: listField(layout.status) });
  builder.input(status, "INDEX", { block: oneBased(builder, scope, object) });
  builder.input(status, "ITEM", literal("released"));
  ids.push(status);

  if (arraySize !== undefined && arraySize > 0) {
    const length = builder.add("data_itemoflist", { scope, fields: listField(layout.arrayLength) });
    builder.input(length, "INDEX", { block: oneBased(builder, scope, object) });
    const isArray = builder.add("operator_gt", { scope });
    builder.input(isArray, "OPERAND1", { block: length });
    builder.input(isArray, "OPERAND2", numberLiteral("0"));
    const guard = builder.add("control_if", { scope });
    builder.input(guard, "CONDITION", { block: isArray });

    const startValue = builder.add("data_itemoflist", { scope, fields: listField(layout.arrayStart) });
    builder.input(startValue, "INDEX", { block: oneBased(builder, scope, object) });
    const addStart = builder.add("data_addtolist", { scope, fields: listField(layout.freeStart) });
    builder.input(addStart, "ITEM", { block: startValue });
    const sizeValue = builder.add("data_itemoflist", { scope, fields: listField(layout.arrayLength) });
    builder.input(sizeValue, "INDEX", { block: oneBased(builder, scope, object) });
    const addSize = builder.add("data_addtolist", { scope, fields: listField(layout.freeSize) });
    builder.input(addSize, "ITEM", { block: sizeValue });
    builder.chain([addStart, addSize]);
    builder.substack(guard, "SUBSTACK", addStart);
    ids.push(guard);
  }

  const free = builder.add("data_addtolist", { scope, fields: listField(layout.freeObjects) });
  builder.input(free, "ITEM", object);
  ids.push(free);
  return ids;
}
