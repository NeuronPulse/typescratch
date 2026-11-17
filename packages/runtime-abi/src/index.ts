import { stableId } from "@typescratch/graph";

export type AbiValueType = "number" | "string" | "boolean" | "void";
export type AbiArgumentType = "NUMBER" | "STRING" | "BOOLEAN";

export interface AbiArgument {
  name: string;
  type: AbiArgumentType;
}

export interface ExtensionOpcodeSpec {
  intrinsic: string;
  opcode: string;
  blockType: "REPORTER" | "BOOLEAN" | "COMMAND";
  text: string;
  arguments: AbiArgument[];
  returns: AbiValueType;
  guard: "number" | "string";
  build(values: string[]): string;
  /**
   * Stateful ops (Frame ABI) override the default pure `build` handler with a
   * body that can read/write worker state. When set, `build` is ignored.
   */
  body?: (values: string[]) => string[];
  /**
   * If true the handler must let exceptions reach TurboWarp's VM thread
   * instead of swallowing them into an in-band fallback value. Required by
   * frameGet's typed-failure contract.
   */
  throws?: boolean;
}

const numberArgs = (...names: string[]): AbiArgument[] =>
  names.map((name) => ({ name, type: "NUMBER" }));

const stringArgs = (...names: string[]): AbiArgument[] =>
  names.map((name) => ({ name, type: "STRING" }));

export const EXTENSION_OPS: Readonly<Record<string, ExtensionOpcodeSpec>> = {
  "ext.Math.hypot": {
    intrinsic: "ext.Math.hypot",
    opcode: "tscr_intrinsic_math_hypot",
    blockType: "REPORTER",
    text: "hypot [A] [B]",
    arguments: numberArgs("A", "B"),
    returns: "number",
    guard: "number",
    build: (values) => `Math.hypot(${values.join(", ")})`,
  },
  "ext.Math.cbrt": {
    intrinsic: "ext.Math.cbrt",
    opcode: "tscr_intrinsic_math_cbrt",
    blockType: "REPORTER",
    text: "cbrt [A]",
    arguments: numberArgs("A"),
    returns: "number",
    guard: "number",
    build: (values) => `Math.cbrt(${values[0] ?? "0"})`,
  },
  "ext.String.toUpperCase": {
    intrinsic: "ext.String.toUpperCase",
    opcode: "tscr_intrinsic_string_upper",
    blockType: "REPORTER",
    text: "uppercase [A]",
    arguments: stringArgs("A"),
    returns: "string",
    guard: "string",
    build: (values) => `String(${values[0] ?? '""'}).toUpperCase()`,
  },
  "ext.String.toLowerCase": {
    intrinsic: "ext.String.toLowerCase",
    opcode: "tscr_intrinsic_string_lower",
    blockType: "REPORTER",
    text: "lowercase [A]",
    arguments: stringArgs("A"),
    returns: "string",
    guard: "string",
    build: (values) => `String(${values[0] ?? '""'}).toLowerCase()`,
  },
};

/**
 * §5.8 Route A Frame ABI primitives. One Map per extension worker, a monotonic
 * counter plus free-id list for callId allocation, and a throw-on-missing
 * contract so an ABI violation can never be mistaken for a program value.
 * `callId` is passed as the first argument of every stateful op.
 */
export const FRAME_EXTENSION_OPS: Readonly<Record<string, ExtensionOpcodeSpec>> = {
  "abi.frame.alloc": {
    intrinsic: "abi.frame.alloc", opcode: "tscr_frame_alloc",
    blockType: "REPORTER", text: "frameAlloc", arguments: [],
    returns: "number", guard: "number",
    build: () => "0",
    body: () => [
      "const id = freeIds.length > 0 ? freeIds.pop() : nextId++;",
      "if (id >= 200000) throw new Error('MAX_FRAME_DEPTH');",
      "frames.set(id, { slots: new Map() });",
      "return id;",
    ],
  },
  "abi.frame.free": {
    intrinsic: "abi.frame.free", opcode: "tscr_frame_free",
    blockType: "COMMAND", text: "frameFree [A]", arguments: numberArgs("A"),
    returns: "void", guard: "number",
    build: (values) => values[0] ?? "0",
    // §5.8 native `emitFrameRelease` tombstones status and returns the id to
    // the free list — it never deletes returnValue/returnTag slots. The caller
    // reads its return value *after* the callee's frameReturn, so deleting the
    // Map entry here makes a correct call look like TSCR_FRAME_MISSING. Keep
    // the data; frameAlloc overwrites the frame when the id is reused.
    body: (values) => [
      `const freed = frames.get(${values[0]});`,
      `if (freed) freed.status = "completed";`,
      `freeIds.push(${values[0]});`,
    ],
  },
  "abi.frame.set": {
    intrinsic: "abi.frame.set", opcode: "tscr_frame_set",
    blockType: "COMMAND", text: "frameSet [A] [B] [C]",
    arguments: [...numberArgs("A"), ...stringArgs("B", "C")],
    returns: "number", guard: "number",
    build: (values) => values[0] ?? "0",
    body: (values) => [
      `const frame = frames.get(${values[0]});`,
      `if (!frame) { window.__tscrFrameStats.missingErrors++; throw new Error('TSCR_FRAME_MISSING: set ' + ${values[0]}); }`,
      `frame.slots.set(${values[1]}, String(${values[2]}));`,
    ],
    throws: true,
  },
  "abi.frame.get": {
    intrinsic: "abi.frame.get", opcode: "tscr_frame_get",
    blockType: "REPORTER", text: "frameGet [A] [B]",
    arguments: [...numberArgs("A"), ...stringArgs("B")],
    returns: "string", guard: "string",
    build: () => `""`,
    body: (values) => [
      `const frame = frames.get(${values[0]});`,
      `if (!frame) { window.__tscrFrameStats.missingErrors++; throw new Error('TSCR_FRAME_MISSING: get ' + ${values[0]}); }`,
      `if (!frame.slots.has(${values[1]})) { window.__tscrFrameStats.missingErrors++; throw new Error('TSCR_FRAME_MISSING: slot ' + ${values[1]}); }`,
      `console.log("GET id=" + ${values[0]} + " slot=" + ${values[1]} + " value=" + frame.slots.get(${values[1]})); return frame.slots.get(${values[1]});`,
    ],
    throws: true,
  },
};

/** Boilerplate injected once into the generated extension for stateful frame ops. */
export const FRAME_EXTENSION_PREAMBLE = [
  "const frames = new Map();",
  "let nextId = 0;",
  "const freeIds = [];",
  "window.__tscrFrameStats = { orphanCount: () => frames.size, missingErrors: 0 };",
].join("\n");

export const ABI_VALUE_TYPES: ReadonlySet<AbiValueType> = new Set([
  "number", "string", "boolean", "void",
]);

export function extensionIdFor(entry: string, intrinsicNames: string[]): string {
  const sorted = [...new Set(intrinsicNames)].sort();
  return `tscr${stableId(entry, sorted.join(",")).slice(0, 12)}`;
}

export function fullOpcode(extensionId: string, spec: ExtensionOpcodeSpec): string {
  return `${extensionId}_${spec.opcode}`;
}

export * from "./value.ts";
export * from "./conformance.ts";
export * from "./profile.ts";
export * from "./frame.ts";
export * from "./memory.ts";
export * from "./dispatch.ts";
export * from "./execution.ts";
export * from "./capability.ts";
export * from "./cost.ts";
