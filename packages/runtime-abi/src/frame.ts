import type { ValuePayload, ValueTag } from "./value.ts";

export type FrameId = number;

export const NULL_FRAME: FrameId = -1;
export const MAX_FRAME_DEPTH = 200000;
export const FREE_FRAME_LIST = "abi.freeFrames";

export const FRAME_LIST_NAMES = [
  "abi.frame.function",
  "abi.frame.parent",
  "abi.frame.returnAddress",
  "abi.frame.returnTag",
  "abi.frame.returnValue",
  "abi.frame.status",
] as const;

export type FrameStatus = "running" | "returning" | "completed";

export function frameLocalList(slot: number): string {
  return `abi.frame.local.${slot}`;
}

export function frameTempList(slot: number): string {
  return `abi.frame.temp.${slot}`;
}

export function frameListNames(localCount: number, tempCount: number): readonly string[] {
  const names: string[] = [...FRAME_LIST_NAMES, FREE_FRAME_LIST];
  for (let slot = 0; slot < localCount; slot++) names.push(frameLocalList(slot));
  for (let slot = 0; slot < tempCount; slot++) names.push(frameTempList(slot));
  return names;
}

export interface FrameRecord {
  functionId: number;
  parent: FrameId | null;
  returnAddress: string;
  returnTag: ValueTag | "";
  returnValue: ValuePayload | "";
  status: FrameStatus;
  locals: readonly ValuePayload[];
  temps: readonly ValuePayload[];
}

export interface FrameAllocatorState {
  nextFrameId: number;
  freeFrames: readonly FrameId[];
}

export const INITIAL_FRAME_ALLOCATOR: FrameAllocatorState = {
  nextFrameId: 0,
  freeFrames: [],
};

export function allocateFrameId(
  state: FrameAllocatorState,
): { id: FrameId; state: FrameAllocatorState } {
  if (state.freeFrames.length > 0) {
    const id = state.freeFrames[state.freeFrames.length - 1]!;
    return { id, state: { ...state, freeFrames: state.freeFrames.slice(0, -1) } };
  }
  const id = state.nextFrameId;
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new RangeError(`abi.nextFrameId is invalid: ${id}`);
  }
  if (id >= MAX_FRAME_DEPTH) {
    throw new RangeError(
      `frame depth limit ${MAX_FRAME_DEPTH} reached; scratch-vm silently drops extra list items`,
    );
  }
  return { id, state: { ...state, nextFrameId: id + 1 } };
}

export function releaseFrameId(state: FrameAllocatorState, id: FrameId): FrameAllocatorState {
  if (!Number.isSafeInteger(id) || id < 0) throw new RangeError(`invalid frame id ${id}`);
  if (state.freeFrames.includes(id)) throw new Error(`frame ${id} released twice`);
  return { ...state, freeFrames: [...state.freeFrames, id] };
}

export interface FrameTableState {
  slots: ReadonlyMap<FrameId, FrameRecord>;
  allocator: FrameAllocatorState;
}

export const INITIAL_FRAME_TABLE: FrameTableState = {
  slots: new Map(),
  allocator: INITIAL_FRAME_ALLOCATOR,
};

export function pushFrame(
  state: FrameTableState,
  record: FrameRecord,
): { id: FrameId; state: FrameTableState } {
  const allocated = allocateFrameId(state.allocator);
  const slots = new Map(state.slots);
  slots.set(allocated.id, record);
  return { id: allocated.id, state: { slots, allocator: allocated.state } };
}

export function popFrame(state: FrameTableState, id: FrameId): FrameTableState {
  if (!state.slots.has(id)) throw new Error(`unknown frame ${id}`);
  const slots = new Map(state.slots);
  slots.delete(id);
  return { slots, allocator: releaseFrameId(state.allocator, id) };
}

export function readFrame(state: FrameTableState, id: FrameId): FrameRecord | undefined {
  return state.slots.get(id);
}

export function writeFrame(
  state: FrameTableState,
  id: FrameId,
  patch: Partial<FrameRecord>,
): FrameTableState {
  const current = state.slots.get(id);
  if (!current) throw new Error(`unknown frame ${id}`);
  const slots = new Map(state.slots);
  slots.set(id, { ...current, ...patch });
  return { ...state, slots };
}
