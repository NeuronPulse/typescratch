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
  blockType: "REPORTER" | "BOOLEAN";
  text: string;
  arguments: AbiArgument[];
  returns: AbiValueType;
  guard: "number" | "string";
  build(values: string[]): string;
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
