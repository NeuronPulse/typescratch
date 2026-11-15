import type { ValuePayload } from "./value.ts";

/** An ObjectRef is an index into the parallel heap lists, never an expanded per-class global. */
export type ObjectRef = number;

export const NULL_OBJECT: ObjectRef = -1;
export const MAX_OBJECTS = 200000;

export const HEAP_CLASS_LIST = "heap.classId";
export const HEAP_STATUS_LIST = "heap.status";
export const HEAP_FREE_LIST = "heap.freeObjects";
export const HEAP_NEXT_ID = "heap.nextObjectId";
export const HEAP_ARRAY_START = "heap.array.start";
export const HEAP_ARRAY_LENGTH = "heap.array.length";
export const HEAP_ARRAY_ITEMS = "heap.array.items";
export const ARRAY_CLASS = "Array";

export function heapFieldList(field: string): string {
  return `heap.field.${field}`;
}

/** Lists indexed by ObjectRef. The same index in every list describes one object. */
export function heapParallelLists(fields: readonly string[]): readonly string[] {
  return [
    HEAP_CLASS_LIST,
    HEAP_STATUS_LIST,
    HEAP_ARRAY_START,
    HEAP_ARRAY_LENGTH,
    ...fields.map(heapFieldList),
  ];
}

export function heapAllListNames(fields: readonly string[]): readonly string[] {
  return [...heapParallelLists(fields), HEAP_ARRAY_ITEMS, HEAP_FREE_LIST];
}

export type HeapFieldType = "number" | "string" | "boolean";

export interface HeapFieldSpec {
  readonly name: string;
  readonly type: HeapFieldType;
  readonly initial: ValuePayload;
}

export interface HeapClassSpec {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly HeapFieldSpec[];
  readonly methods: readonly string[];
}

export interface HeapAllocatorState {
  nextObjectId: number;
  freeObjects: readonly ObjectRef[];
}

export const INITIAL_HEAP_ALLOCATOR: HeapAllocatorState = {
  nextObjectId: 0,
  freeObjects: [],
};

export function allocateObjectId(
  state: HeapAllocatorState,
): { id: ObjectRef; state: HeapAllocatorState } {
  if (state.freeObjects.length > 0) {
    const id = state.freeObjects[state.freeObjects.length - 1]!;
    return { id, state: { ...state, freeObjects: state.freeObjects.slice(0, -1) } };
  }
  const id = state.nextObjectId;
  if (!Number.isSafeInteger(id) || id < 0) throw new RangeError(`heap.nextObjectId is invalid: ${id}`);
  if (id >= MAX_OBJECTS) {
    throw new RangeError(
      `heap object limit ${MAX_OBJECTS} reached; scratch-vm silently drops extra list items`,
    );
  }
  return { id, state: { ...state, nextObjectId: id + 1 } };
}

export function releaseObjectId(state: HeapAllocatorState, id: ObjectRef): HeapAllocatorState {
  if (!Number.isSafeInteger(id) || id < 0) throw new RangeError(`invalid object ref ${id}`);
  if (state.freeObjects.includes(id)) throw new Error(`object ${id} released twice`);
  return { ...state, freeObjects: [...state.freeObjects, id] };
}

export type HeapStatus = "live" | "released";

export interface HeapRecord {
  readonly classId: string;
  readonly fields: ReadonlyMap<string, ValuePayload>;
  readonly arrayStart: number;
  readonly arrayLength: number;
  readonly status: HeapStatus;
}

export interface HeapTableState {
  readonly objects: ReadonlyMap<ObjectRef, HeapRecord>;
  readonly items: readonly ValuePayload[];
  readonly allocator: HeapAllocatorState;
}

export const INITIAL_HEAP_TABLE: HeapTableState = {
  objects: new Map(),
  items: [],
  allocator: INITIAL_HEAP_ALLOCATOR,
};

export function heapNew(
  state: HeapTableState,
  classId: string,
  fieldInitials: ReadonlyMap<string, ValuePayload> = new Map(),
  arraySize = 0,
): { ref: ObjectRef; state: HeapTableState } {
  if (!Number.isSafeInteger(arraySize) || arraySize < 0) {
    throw new RangeError(`invalid array size ${arraySize}`);
  }
  if (state.items.length + arraySize > MAX_OBJECTS) {
    throw new RangeError(`heap array item limit ${MAX_OBJECTS} reached`);
  }
  const allocated = allocateObjectId(state.allocator);
  const arrayStart = state.items.length;
  const items = arraySize > 0
    ? [...state.items, ...Array.from({ length: arraySize }, () => 0 as ValuePayload)]
    : [...state.items];
  const record: HeapRecord = {
    classId,
    fields: new Map(fieldInitials),
    arrayStart,
    arrayLength: arraySize,
    status: "live",
  };
  const objects = new Map(state.objects);
  objects.set(allocated.id, record);
  return { ref: allocated.id, state: { objects, items, allocator: allocated.state } };
}

function liveRecord(state: HeapTableState, ref: ObjectRef): HeapRecord {
  const record = state.objects.get(ref);
  if (!record) throw new Error(`unknown object ref ${ref}`);
  if (record.status !== "live") throw new Error(`object ref ${ref} is released`);
  return record;
}

export function heapRead(state: HeapTableState, ref: ObjectRef): HeapRecord {
  return liveRecord(state, ref);
}

export function heapClassOf(state: HeapTableState, ref: ObjectRef): string {
  return liveRecord(state, ref).classId;
}

export function heapReadField(state: HeapTableState, ref: ObjectRef, field: string): ValuePayload {
  return liveRecord(state, ref).fields.get(field) ?? 0;
}

export function heapWriteField(
  state: HeapTableState,
  ref: ObjectRef,
  field: string,
  value: ValuePayload,
): HeapTableState {
  const record = liveRecord(state, ref);
  const fields = new Map(record.fields);
  fields.set(field, value);
  const objects = new Map(state.objects);
  objects.set(ref, { ...record, fields });
  return { ...state, objects };
}

export function heapArrayLength(state: HeapTableState, ref: ObjectRef): number {
  return liveRecord(state, ref).arrayLength;
}

export function heapReadArray(state: HeapTableState, ref: ObjectRef, index: number): ValuePayload {
  const record = liveRecord(state, ref);
  if (!Number.isSafeInteger(index) || index < 0 || index >= record.arrayLength) return "";
  return state.items[record.arrayStart + index] ?? 0;
}

export function heapWriteArray(
  state: HeapTableState,
  ref: ObjectRef,
  index: number,
  value: ValuePayload,
): HeapTableState {
  const record = liveRecord(state, ref);
  if (!Number.isSafeInteger(index) || index < 0 || index >= record.arrayLength) return state;
  const items = [...state.items];
  items[record.arrayStart + index] = value;
  return { ...state, items };
}

/**
 * Releases an object and returns its id to the free list. When the object's
 * array range is the top of the item stack (LIFO release order) the range is
 * trimmed, so repeated allocate/release cycles do not grow `heap.array.items`.
 * Out-of-order releases leave a hole instead of shifting later ranges.
 */
export function heapRelease(state: HeapTableState, ref: ObjectRef): HeapTableState {
  const record = liveRecord(state, ref);
  const objects = new Map(state.objects);
  objects.set(ref, { ...record, status: "released" });
  const end = record.arrayStart + record.arrayLength;
  const items = record.arrayLength > 0 && end === state.items.length
    ? state.items.slice(0, record.arrayStart)
    : state.items;
  return {
    objects,
    items,
    allocator: releaseObjectId(state.allocator, ref),
  };
}

/** Value ABI `o` tag: object identity is the heap index, not the field contents. */
export function objectStrictEquals(left: ObjectRef, right: ObjectRef): boolean {
  return left !== NULL_OBJECT && right !== NULL_OBJECT && left === right;
}
