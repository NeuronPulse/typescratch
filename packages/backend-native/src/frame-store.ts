import type { SourceSpan } from "@typescratch/diagnostics";
import type { BlockId, GraphBuilder, InputRef } from "@typescratch/graph";
import {
  declareFrameLayout,
  emitFrameAllocate,
  emitFrameReturnReadAt,
  emitFrameSlotAppend,
  emitFrameSlotRead,
  emitFrameSlotWrite,
  type FrameLayout,
  type FrameRef,
} from "./frame-blocks.ts";

/**
 * Inputs that must be generated *after* their owner block exists are passed as
 * thunks. Block ids are assigned by creation order, so eagerly creating an
 * InputRef would shift every subsequent id and change the golden projects.
 */
export type FrameInput = (owner: BlockId) => InputRef;

/** The storage medium behind the Call/Frame ABI. Native is the reference. */
export interface FrameStore {
  readonly strategy: "native" | "extension";
  declareLayout(builder: GraphBuilder): FrameLayout;
  /**
   * Address of a frame slot. Native parallel lists are 1-based (`callId + 1`);
   * the Extension Map is keyed by the raw callId. Callers must never hard-code
   * the offset — recursion's `abi.frame.callToken` chain depends on it.
   */
  keyOf(
    builder: GraphBuilder, scope: string, span: SourceSpan | undefined,
    callId: FrameInput,
  ): InputRef;
  allocate(builder: GraphBuilder, scope: string, layout: FrameLayout, token: FrameRef): BlockId[];
  appendSlots(builder: GraphBuilder, scope: string, layout: FrameLayout, token: FrameRef): BlockId[];
  writeSlot(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    listName: string, owner: InputRef, value: InputRef, span?: SourceSpan,
  ): BlockId;
  readSlot(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    listName: string, owner: InputRef, span?: SourceSpan,
  ): BlockId;
  readReturnAt(builder: GraphBuilder, scope: string, layout: FrameLayout, token: InputRef): BlockId;
  readTagAt(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    token: FrameInput, span?: SourceSpan,
  ): BlockId;
  writeReturn(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    callId: FrameInput, value: FrameInput, span?: SourceSpan,
  ): BlockId;
  writeTag(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    callId: FrameInput, tag: string, span?: SourceSpan,
  ): BlockId;
  complete(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    statusToken: FrameInput, freeToken: FrameInput, span?: SourceSpan,
  ): BlockId[];
}

function listField(ref: FrameRef): Record<string, [string, string | null]> {
  return { LIST: [ref.name, ref.id] };
}

/** Native parallel-list implementation — byte-for-byte equivalent to the pre-adapter emitter. */
export const nativeFrameStore: FrameStore = {
  strategy: "native",

  keyOf(builder, scope, span, callId) {
    const add = builder.add("operator_add", { scope, span });
    builder.input(add, "NUM1", callId(add));
    builder.input(add, "NUM2", { primitive: [4, "1"] });
    return { block: add };
  },

  declareLayout(builder) {
    return declareFrameLayout(builder);
  },

  allocate(builder, scope, layout, token) {
    return emitFrameAllocate(builder, scope, layout, token);
  },

  appendSlots(builder, scope, layout, token) {
    return emitFrameSlotAppend(builder, scope, layout, token);
  },

  writeSlot(builder, scope, layout, listName, owner, value) {
    return emitFrameSlotWrite(builder, scope, layout, listName, owner, value);
  },

  readSlot(builder, scope, layout, listName, owner) {
    return emitFrameSlotRead(builder, scope, layout, listName, owner);
  },

  readReturnAt(builder, scope, layout, token) {
    return emitFrameReturnReadAt(builder, scope, layout, token);
  },

  readTagAt(builder, scope, layout, token, span) {
    const ref = layout.lists["abi.frame.returnTag"]!;
    const item = builder.add("data_itemoflist", { scope, fields: listField(ref) });
    const index = builder.add("operator_add", { scope, parent: item, span });
    builder.input(index, "NUM1", token(index));
    builder.input(index, "NUM2", { primitive: [4, "1"] });
    builder.input(item, "INDEX", { block: index });
    return item;
  },

  writeReturn(builder, scope, layout, callId, value, span) {
    const ref = layout.lists["abi.frame.returnValue"]!;
    const replace = builder.add("data_replaceitemoflist", { scope, span, fields: listField(ref) });
    const index = builder.add("operator_add", { scope, parent: replace, span });
    builder.input(index, "NUM1", callId(index));
    builder.input(index, "NUM2", { primitive: [4, "1"] });
    builder.input(replace, "INDEX", { block: index });
    builder.input(replace, "ITEM", value(replace));
    return replace;
  },

  writeTag(builder, scope, layout, callId, tag, span) {
    const ref = layout.lists["abi.frame.returnTag"]!;
    const replace = builder.add("data_replaceitemoflist", { scope, span, fields: listField(ref) });
    const index = builder.add("operator_add", { scope, parent: replace, span });
    builder.input(index, "NUM1", callId(index));
    builder.input(index, "NUM2", { primitive: [4, "1"] });
    builder.input(replace, "INDEX", { block: index });
    builder.input(replace, "ITEM", { primitive: [10, tag] });
    return replace;
  },

  complete(builder, scope, layout, statusToken, freeToken, span) {
    const status = layout.lists["abi.frame.status"]!;
    const replace = builder.add("data_replaceitemoflist", { scope, span, fields: listField(status) });
    const index = builder.add("operator_add", { scope, parent: replace, span });
    builder.input(index, "NUM1", statusToken(index));
    builder.input(index, "NUM2", { primitive: [4, "1"] });
    builder.input(replace, "INDEX", { block: index });
    builder.input(replace, "ITEM", { primitive: [10, "completed"] });
    const free = builder.add("data_addtolist", {
      scope, span, fields: listField(layout.freeFrames),
    });
    builder.input(free, "ITEM", freeToken(free));
    return [replace, free];
  },
};
