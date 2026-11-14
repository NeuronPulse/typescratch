export type Target = "scratch" | "turbowarp";
export type ValueType = "number" | "string" | "boolean" | "void";

export interface IntrinsicSpec {
  name: string;
  kind: "command" | "reporter";
  params: ValueType[];
  returns: ValueType;
  backend: "native" | "extension";
  opcode?: string;
  inputs?: string[];
  mathOperator?: string;
}

const command = (name: string, opcode: string, params: ValueType[], inputs: string[]): IntrinsicSpec => ({
  name, kind: "command", params, returns: "void", backend: "native", opcode, inputs,
});

const mathop = (name: string, operator: string): IntrinsicSpec => ({
  name, kind: "reporter", params: ["number"], returns: "number",
  backend: "native", opcode: "operator_mathop", inputs: ["NUM"], mathOperator: operator,
});

export const MATH_INTRINSICS: Readonly<Record<string, string>> = {
  sqrt: "math.sqrt",
  abs: "math.abs",
  floor: "math.floor",
  ceil: "math.ceil",
  round: "math.round",
  sin: "math.sin",
  cos: "math.cos",
  tan: "math.tan",
  log: "math.ln",
  log10: "math.log",
};

export const RESOURCE_INTRINSICS: ReadonlySet<string> = new Set([
  "global", "local", "get", "set", "change",
]);

export const INTRINSICS: Readonly<Record<string, IntrinsicSpec>> = {
  say: command("say", "looks_say", ["string"], ["MESSAGE"]),
  wait: command("wait", "control_wait", ["number"], ["DURATION"]),
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
  "math.ln": mathop("math.ln", "ln"),
  "math.log": mathop("math.log", "log"),
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
      name, kind: "reporter", params: [], returns: "number", backend: "extension",
    };
  }
  return undefined;
}
