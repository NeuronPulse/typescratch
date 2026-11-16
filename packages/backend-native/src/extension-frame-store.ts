import { FRAME_EXTENSION_OPS, fullOpcode } from "@typescratch/runtime-abi";
import type { BlockId, GraphBuilder, InputRef } from "@typescratch/graph";
import type { FrameLayout, FrameRef } from "./frame-blocks.ts";
import type { FrameInput, FrameStore } from "./frame-store.ts";

const OP = (name: keyof typeof FRAME_EXTENSION_OPS) => FRAME_EXTENSION_OPS[name]!;

/** Placeholder layout: Extension frames live in the worker, not in Scratch lists. */
function emptyLayout(): FrameLayout {
  return {
    nextFrameId: { id: "__ext_next", name: "__ext_next" },
    freeFrames: { id: "__ext_free", name: "__ext_free" },
    lists: {},
  };
}

const primitive = (value: string): InputRef => ({ primitive: [4, value] });

/**
 * Extension Frame ABI — Route A. Only frame *storage* moves to a per-worker JS
 * Map. callId remains a scalar variable, `procedures_call` and CFG stay Native.
 */
export class ExtensionFrameStore implements FrameStore {
  readonly strategy = "extension" as const;
  private readonly extensionId: string;
  constructor(extensionId: string) {
    this.extensionId = extensionId;
  }

  private opcode(name: keyof typeof FRAME_EXTENSION_OPS): string {
    return fullOpcode(this.extensionId, OP(name));
  }

  declareLayout(): FrameLayout {
    return emptyLayout();
  }

  allocate(builder: GraphBuilder, scope: string, _layout: FrameLayout, token: FrameRef): BlockId[] {
    const alloc = builder.add(this.opcode("abi.frame.alloc"), { scope });
    const set = builder.add("data_setvariableto", {
      scope, fields: { VARIABLE: [token.name, token.id] as [string, string] },
    });
    builder.input(set, "VALUE", { block: alloc });
    // Only `set` is a top-level statement; `alloc` is its VALUE input block.
    return [set];
  }

  appendSlots(): BlockId[] {
    // allocate() creates the frame with an empty slot Map.
    return [];
  }

  writeSlot(
    builder: GraphBuilder, scope: string, _layout: FrameLayout,
    listName: string, owner: InputRef, value: InputRef,
  ): BlockId {
    const block = builder.add(this.opcode("abi.frame.set"), { scope });
    builder.input(block, "A", owner);
    builder.input(block, "B", primitive(listName));
    builder.input(block, "C", value);
    return block;
  }

  readSlot(
    builder: GraphBuilder, scope: string, _layout: FrameLayout,
    listName: string, owner: InputRef,
  ): BlockId {
    const block = builder.add(this.opcode("abi.frame.get"), { scope });
    builder.input(block, "A", owner);
    builder.input(block, "B", primitive(listName));
    return block;
  }

  readReturnAt(builder: GraphBuilder, scope: string, layout: FrameLayout, token: InputRef): BlockId {
    return this.readSlot(builder, scope, layout, "abi.frame.returnValue", token);
  }

  readTagAt(builder: GraphBuilder, scope: string, layout: FrameLayout, token: FrameInput): BlockId {
    // Extension frame ops take the token directly as a primitive input — no
    // owner-dependent block is needed, so the thunk is never deferred.
    return this.readSlot(builder, scope, layout, "abi.frame.returnTag", token(""));
  }

  writeReturn(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    callId: FrameInput, value: FrameInput,
  ): BlockId {
    return this.writeSlot(
      builder, scope, layout, "abi.frame.returnValue",
      callId(""), value(""),
    );
  }

  writeTag(
    builder: GraphBuilder, scope: string, layout: FrameLayout,
    callId: FrameInput, tag: string,
  ): BlockId {
    return this.writeSlot(builder, scope, layout, "abi.frame.returnTag", callId(""), primitive(tag));
  }

  complete(
    builder: GraphBuilder, scope: string, _layout: FrameLayout,
    _statusToken: FrameInput, freeToken: FrameInput,
  ): BlockId[] {
    const free = builder.add(this.opcode("abi.frame.free"), { scope });
    builder.input(free, "A", freeToken(""));
    return [free];
  }
}
