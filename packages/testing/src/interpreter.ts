import type { BinOp, Expr, FunctionDecl, IrType, Module, Stmt, VarDecl } from "@typescratch/ir";
import { castToBoolean, castToNumber, castToString } from "@typescratch/language";

export type TraceValue = string | number | boolean;
export type ValueProfile = "scratch" | "javascript";

export interface ExecutionTrace {
  says: string[];
  commands: string[];
  variables: Record<string, TraceValue>;
  lists: Record<string, TraceValue[]>;
  steps: number;
}

export interface InterpretOptions {
  maxSteps?: number;
  profile?: ValueProfile;
}

const DEFAULT_MAX_STEPS = 100_000;

export function jsNumber(value: TraceValue): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number(value);
}

export const toNumber = castToNumber;
export const toBoolean = castToBoolean;
export const toStringValue = castToString;

export function compareValues(left: TraceValue, right: TraceValue): number {
  const numericLeft = typeof left === "string" && left.trim() === "" ? Number.NaN : jsNumber(left);
  const numericRight = typeof right === "string" && right.trim() === "" ? Number.NaN : jsNumber(right);
  if (!Number.isNaN(numericLeft) && !Number.isNaN(numericRight)) {
    if (numericLeft === numericRight) return 0;
    return numericLeft < numericRight ? -1 : 1;
  }
  const textLeft = toStringValue(left).toLowerCase();
  const textRight = toStringValue(right).toLowerCase();
  if (textLeft === textRight) return 0;
  return textLeft < textRight ? -1 : 1;
}

export function scratchModulo(left: TraceValue, right: TraceValue): number {
  const dividend = toNumber(left);
  const divisor = toNumber(right);
  if (divisor === 0) return Number.NaN;
  let result = dividend % divisor;
  if (result / divisor < 0) result += divisor;
  return result;
}

export function evalBinary(op: BinOp, left: TraceValue, right: TraceValue, profile: ValueProfile): TraceValue {
  const numeric = (value: TraceValue): number => profile === "javascript" ? jsNumber(value) : toNumber(value);
  switch (op) {
    case "add":
      if (profile === "javascript" && (typeof left === "string" || typeof right === "string")) {
        return toStringValue(left) + toStringValue(right);
      }
      return numeric(left) + numeric(right);
    case "sub": return numeric(left) - numeric(right);
    case "mul": return numeric(left) * numeric(right);
    case "div": return numeric(left) / numeric(right);
    case "mod":
      return profile === "javascript" ? jsNumber(left) % jsNumber(right) : scratchModulo(left, right);
    case "lt":
      return profile === "javascript" ? jsNumber(left) < jsNumber(right) : compareValues(left, right) < 0;
    case "gt":
      return profile === "javascript" ? jsNumber(left) > jsNumber(right) : compareValues(left, right) > 0;
    case "le":
      return profile === "javascript" ? jsNumber(left) <= jsNumber(right) : compareValues(left, right) <= 0;
    case "ge":
      return profile === "javascript" ? jsNumber(left) >= jsNumber(right) : compareValues(left, right) >= 0;
    case "eq":
      return profile === "javascript" ? left === right : compareValues(left, right) === 0;
    case "ne":
      return profile === "javascript" ? left !== right : compareValues(left, right) !== 0;
    case "and": return toBoolean(left) && toBoolean(right);
    case "or": return toBoolean(left) || toBoolean(right);
  }
}

const MATH_FUNCTIONS: Readonly<Record<string, (value: number) => number>> = {
  "math.sqrt": Math.sqrt,
  "math.abs": Math.abs,
  "math.floor": Math.floor,
  "math.ceil": Math.ceil,
  "math.round": Math.round,
  "math.sin": Math.sin,
  "math.cos": Math.cos,
  "math.tan": Math.tan,
  "math.ln": Math.log,
  "math.log": Math.log10,
};

export function evalIntrinsic(name: string, args: TraceValue[], profile: ValueProfile = "scratch"): TraceValue {
  const asNumber = (value: TraceValue): number => profile === "javascript" ? jsNumber(value) : toNumber(value);
  const mathFunction = MATH_FUNCTIONS[name];
  if (mathFunction) return mathFunction(asNumber(args[0] ?? 0));
  if (name === "ext.Math.hypot") return Math.hypot(...args.map(asNumber));
  if (name === "ext.Math.cbrt") return Math.cbrt(asNumber(args[0] ?? 0));
  if (name === "ext.String.toUpperCase") return toStringValue(args[0] ?? "").toUpperCase();
  if (name === "ext.String.toLowerCase") return toStringValue(args[0] ?? "").toLowerCase();
  throw new Error(`IR interpreter has no evaluation rule for intrinsic ${name}`);
}

function tagOf(type: IrType): string {
  if (type === "number") return "n";
  if (type === "string") return "s";
  if (type === "boolean") return "b";
  return "u";
}

function defaultValue(decl: VarDecl): TraceValue {
  if (decl.initial !== undefined) return decl.initial;
  if (decl.type === "string") return "";
  if (decl.type === "boolean") return false;
  return 0;
}

function ownerOf(module: Module, decl: VarDecl): string {
  return decl.storage === "global" ? "Stage" : (module.role?.name ?? "Sprite1");
}

export function interpretModules(modules: Module[], options: InterpretOptions = {}): ExecutionTrace {
  const profile = options.profile ?? "scratch";
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const trace: ExecutionTrace = {
    says: [], commands: [], variables: {}, lists: {}, steps: 0,
  };
  const values = new Map<string, TraceValue>();
  const lists = new Map<string, TraceValue[]>();
  const functionMap = new Map<string, FunctionDecl>();
  const classById = new Map(
    modules.flatMap((module) => (module.classes ?? []).map((entry) => [entry.id, entry] as const)),
  );
  for (const module of modules) {
    for (const decl of module.vars) values.set(decl.id, defaultValue(decl));
    for (const decl of module.lists ?? []) lists.set(decl.id, [...(decl.initial ?? [])]);
    for (const fn of module.functions ?? []) functionMap.set(fn.id, fn);
  }

  interface HeapObject {
    classId: string;
    fields: Map<string, TraceValue>;
    start: number;
    length: number;
  }
  const heapObjects = new Map<number, HeapObject>();
  const heapItems: TraceValue[] = [];
  const heapFree: number[] = [];
  let heapNextId = 0;
  const allocateObject = (classId: string, size = 0): number => {
    const ref = heapFree.length > 0 ? heapFree.pop()! : heapNextId++;
    const fields = new Map<string, TraceValue>();
    for (const field of classById.get(classId)?.fields ?? []) {
      fields.set(field.name, field.initial ?? (field.type === "string" ? "" : 0));
    }
    const start = heapItems.length;
    for (let index = 0; index < Math.max(0, size); index++) heapItems.push(0);
    heapObjects.set(ref, { classId, fields, start, length: Math.max(0, size) });
    return ref;
  };
  const fieldRef = (expr: Expr): number => Math.trunc(toNumber(evalExpr(expr)));

  const evalExpr = (expr: Expr): TraceValue => {
    switch (expr.k) {
      case "const": return expr.value;
      case "read": return values.get(expr.var) ?? 0;
      case "join": return expr.parts.map((part) => toStringValue(evalExpr(part))).join("");
      case "unary": {
        const value = evalExpr(expr.value);
        return expr.op === "not" ? !toBoolean(value) : -toNumber(value);
      }
      case "binary": return evalBinary(expr.op, evalExpr(expr.l), evalExpr(expr.r), profile);
      case "convert": {
        const value = evalExpr(expr.value);
        return expr.to === "number" ? toNumber(value) : toBoolean(value);
      }
      case "listRead": {
        const list = lists.get(expr.list) ?? [];
        if (expr.op === "length") return list.length;
        const index = expr.index ? Math.trunc(toNumber(evalExpr(expr.index))) : 0;
        return list[index] ?? "";
      }
      case "intrinsic": return evalIntrinsic(expr.name, expr.args.map(evalExpr), profile);
      case "call": {
        const fn = functionMap.get(expr.function);
        if (!fn) throw new Error(`IR interpreter cannot find function ${expr.function}`);
        return execFunction(fn, expr.args.map(evalExpr));
      }
      case "objectNew":
        return allocateObject(expr.classId);
      case "arrayNew":
        return allocateObject("Array", Math.trunc(toNumber(evalExpr(expr.size))));
      case "fieldRead":
        return heapObjects.get(fieldRef(expr.object))?.fields.get(expr.field) ?? 0;
      case "arrayLength":
        return heapObjects.get(fieldRef(expr.array))?.length ?? 0;
      case "arrayRead": {
        const object = heapObjects.get(fieldRef(expr.array));
        const index = Math.trunc(toNumber(evalExpr(expr.index)));
        if (!object || index < 0 || index >= object.length) return "";
        return heapItems[object.start + index] ?? 0;
      }
      case "methodCall": {
        const classId = heapObjects.get(fieldRef(expr.object))?.classId;
        const target = expr.targets.find((entry) => entry.classId === classId);
        const fn = target ? functionMap.get(target.function) : undefined;
        if (!fn) throw new Error(`IR interpreter cannot dispatch ${expr.method} on ${classId ?? "unknown"}`);
        return execFunction(fn, [fieldRef(expr.object), ...expr.args.map(evalExpr)]);
      }
    }
  };

  const execFunction = (fn: FunctionDecl, args: TraceValue[]): TraceValue => {
    const saved = fn.params.map((param) => values.get(param.id));
    const savedReturning = values.get(fn.returning);
    const savedReturnValue = values.get(fn.returnValue);
    const savedCallId = values.get(fn.callId);
    fn.params.forEach((param, index) => values.set(param.id, args[index] ?? defaultValue(param)));
    values.set(fn.returning, 0);
    values.set(fn.returnValue, 0);
    values.set(fn.callId, 0);
    exec(fn.body);
    const result = values.get(fn.returnValue) ?? 0;
    fn.params.forEach((param, index) => values.set(param.id, saved[index] ?? defaultValue(param)));
    values.set(fn.returning, savedReturning ?? 0);
    values.set(fn.returnValue, savedReturnValue ?? 0);
    values.set(fn.callId, savedCallId ?? 0);
    return result;
  };

  const exec = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      if (++trace.steps > maxSteps) {
        throw new Error(`IR execution exceeded ${maxSteps} steps; check for a non-terminating loop`);
      }
      switch (stmt.k) {
        case "declare":
        case "assign":
          if (stmt.k === "assign" || stmt.init) {
            const value = stmt.k === "assign" ? stmt.value : stmt.init!;
            values.set(stmt.var, evalExpr(value));
          }
          break;
        case "expr": {
          const args = stmt.args.map(evalExpr);
          trace.commands.push(stmt.name);
          if (stmt.name === "say") trace.says.push(toStringValue(args[0] ?? ""));
          break;
        }
        case "list": {
          const list = lists.get(stmt.list) ?? [];
          const args = stmt.args.map(evalExpr);
          const indexOf = (value: TraceValue | undefined): number => Math.trunc(toNumber(value ?? 0));
          switch (stmt.op) {
            case "push":
              list.push(args[0] ?? "");
              break;
            case "insert": {
              const at = indexOf(args[0]);
              if (at >= 0 && at <= list.length) list.splice(at, 0, args[1] ?? "");
              break;
            }
            case "replace": {
              const at = indexOf(args[0]);
              if (at >= 0 && at < list.length) list[at] = args[1] ?? "";
              break;
            }
            case "deleteAt": {
              const at = indexOf(args[0]);
              if (at >= 0 && at < list.length) list.splice(at, 1);
              break;
            }
            case "clear":
              list.length = 0;
              break;
          }
          break;
        }
        case "invoke": {
          const fn = functionMap.get(stmt.function);
          if (!fn) throw new Error(`IR interpreter cannot find function ${stmt.function}`);
          values.set(stmt.result, execFunction(fn, stmt.args.map(evalExpr)));
          values.set(stmt.resultTag, tagOf(fn.returnType));
          break;
        }
        case "heapAllocate":
          values.set(stmt.result, allocateObject(stmt.classId));
          break;
        case "heapArrayAllocate":
          values.set(stmt.result, allocateObject("Array", Math.trunc(toNumber(evalExpr(stmt.size)))));
          break;
        case "fieldWrite": {
          const object = heapObjects.get(fieldRef(stmt.object));
          const value = evalExpr(stmt.value);
          if (object) object.fields.set(stmt.field, value);
          break;
        }
        case "arrayWrite": {
          const object = heapObjects.get(fieldRef(stmt.array));
          const index = Math.trunc(toNumber(evalExpr(stmt.index)));
          const value = evalExpr(stmt.value);
          if (object && index >= 0 && index < object.length) heapItems[object.start + index] = value;
          break;
        }
        case "virtualInvoke": {
          const ref = fieldRef(stmt.object);
          const classId = heapObjects.get(ref)?.classId;
          const target = stmt.targets.find((entry) => entry.classId === classId);
          const fn = target ? functionMap.get(target.function) : undefined;
          if (!fn) {
            throw new Error(`IR interpreter cannot dispatch ${stmt.method} on ${classId ?? "unknown"}`);
          }
          values.set(stmt.result, execFunction(fn, [ref, ...stmt.args.map(evalExpr)]));
          values.set(stmt.resultTag, tagOf(fn.returnType));
          break;
        }
        case "frameReturn":
          break;
        case "return":
          throw new Error("return reached the IR interpreter; lowerControlFlow must run first");
        case "break":
        case "continue":
          throw new Error(`${stmt.k} reached the IR interpreter; lowerControlFlow must run first`);
        case "if":
          exec(toBoolean(evalExpr(stmt.cond)) ? stmt.then : (stmt.else ?? []));
          break;
        case "while":
          while (toBoolean(evalExpr(stmt.cond))) exec(stmt.body);
          break;
        case "sequence":
          exec(stmt.body);
          break;
      }
    }
  };

  for (const module of modules) {
    for (const script of module.scripts) exec(script.body);
  }
  for (const module of modules) {
    for (const decl of module.vars) {
      trace.variables[`${ownerOf(module, decl)}:${decl.name}`] = values.get(decl.id) ?? defaultValue(decl);
    }
    for (const decl of module.lists ?? []) {
      const owner = module.role?.name ?? "Sprite1";
      trace.lists[`${owner}:${decl.name}`] = [...(lists.get(decl.id) ?? [])];
    }
  }
  return trace;
}
