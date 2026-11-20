export type Target = "scratch" | "turbowarp";
export type ValueType = "number" | "string" | "boolean" | "void";
export type RuntimeValue = string | number | boolean;

export function castToNumber(value: RuntimeValue): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function castToBoolean(value: RuntimeValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  const text = value.toLowerCase();
  return text !== "" && text !== "0" && text !== "false";
}

export function castToString(value: RuntimeValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  return value;
}

export interface IntrinsicSpec {
  name: string;
  kind: "command" | "reporter";
  params: ValueType[];
  returns: ValueType;
  backend: "native" | "extension";
  opcode?: string;
  inputs?: string[];
  /** Static Scratch block fields (menu selections), e.g. {TO: "_random_"}. */
  fields?: Record<string, string>;
  mathOperator?: string;
  effect?: "yields";
}

const command = (
  name: string,
  opcode: string,
  params: ValueType[],
  inputs: string[],
  effect?: "yields",
): IntrinsicSpec => ({
  name, kind: "command", params, returns: "void", backend: "native", opcode, inputs,
  ...(effect ? { effect } : {}),
});

const mathop = (name: string, operator: string): IntrinsicSpec => ({
  name, kind: "reporter", params: ["number"], returns: "number",
  backend: "native", opcode: "operator_mathop", inputs: ["NUM"], mathOperator: operator,
});

/**
 * JS Math functions backed by native Scratch blocks. `sin`/`cos`/`tan` and
 * their inverses need a radian↔degree conversion — see the frontend lowering;
 * the intrinsic itself stays a plain `operator_mathop` mapping.
 */
export const MATH_INTRINSICS: Readonly<Record<string, string>> = {
  sqrt: "math.sqrt",
  abs: "math.abs",
  floor: "math.floor",
  ceil: "math.ceil",
  round: "math.round",
  sin: "math.sin",
  cos: "math.cos",
  tan: "math.tan",
  asin: "math.asin",
  acos: "math.acos",
  atan: "math.atan",
  log: "math.ln",
  log10: "math.log",
  exp: "math.exp",
};

/** Which Math functions take/return radians and need conversion. */
export const MATH_RADIAN_IN: ReadonlySet<string> = new Set(["sin", "cos", "tan"]);
export const MATH_RADIAN_OUT: ReadonlySet<string> = new Set(["asin", "acos", "atan"]);

export const RESOURCE_INTRINSICS: ReadonlySet<string> = new Set([
  "global", "local", "get", "set", "change",
]);

export const YIELDING_COMMANDS: ReadonlySet<string> = new Set([
  "wait", "waitUntil", "broadcast", "broadcastAndWait",
]);

export const INTRINSICS: Readonly<Record<string, IntrinsicSpec>> = {
  say: command("say", "looks_say", ["string"], ["MESSAGE"]),
  wait: command("wait", "control_wait", ["number"], ["DURATION"], "yields"),
  // Language-level suspend: the VM re-evaluates CONDITION every step and
  // util.yield()s while it is false. The thread's stack IS the continuation —
  // no frame slot, no broadcast, no host hook (resumption spike 2026-11-18).
  waitUntil: command("waitUntil", "control_wait_until", ["boolean"], ["CONDITION"], "yields"),
  move: command("move", "motion_movesteps", ["number"], ["STEPS"]),
  hide: command("hide", "looks_hide", [], []),
  show: command("show", "looks_show", [], []),
  "math.sqrt": mathop("math.sqrt", "sqrt"),
  "math.abs": mathop("math.abs", "abs"),
  "math.floor": mathop("math.floor", "floor"),
  "math.ceil": mathop("math.ceil", "ceiling"),
  "math.sin": mathop("math.sin", "sin"),
  "math.cos": mathop("math.cos", "cos"),
  "math.tan": mathop("math.tan", "tan"),
  "math.asin": mathop("math.asin", "asin"),
  "math.acos": mathop("math.acos", "acos"),
  "math.atan": mathop("math.atan", "atan"),
  "math.ln": mathop("math.ln", "ln"),
  "math.log": mathop("math.log", "log"),
  "math.exp": mathop("math.exp", "e ^"),
  // Native string operations. charAt needs a 0-based→1-based index adjustment
  // in the frontend; includes/length map directly.
  "string.charAt": {
    name: "string.charAt", kind: "reporter", params: ["number"], returns: "string",
    backend: "native", opcode: "operator_letter_of", inputs: ["LETTER", "STRING"],
  },
  "string.includes": {
    name: "string.includes", kind: "reporter", params: ["string"], returns: "boolean",
    backend: "native", opcode: "operator_contains", inputs: ["STRING1", "STRING2"],
  },
  "string.length": {
    name: "string.length", kind: "reporter", params: [], returns: "number",
    backend: "native", opcode: "operator_length", inputs: ["STRING"],
  },
  "math.round": {
    name: "math.round", kind: "reporter", params: ["number"], returns: "number",
    backend: "native", opcode: "operator_round", inputs: ["NUM"],
  },
};

export function getIntrinsic(name: string): IntrinsicSpec | undefined {
  const known = INTRINSICS[name];
  if (known) return known;
  if (name.startsWith("ext.")) {
    return {
      name, kind: "reporter", params: [], returns: "number",
      backend: "extension", effect: "yields",
    };
  }
  return undefined;
}
