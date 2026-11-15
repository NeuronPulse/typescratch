import type { Expr, Module, Stmt } from "@typescratch/ir";
import { castToBoolean, castToNumber, castToString, type RuntimeValue } from "@typescratch/language";

export interface OptimizeOptions {
  folding?: boolean;
  deadCode?: boolean;
  simplify?: boolean;
}

export interface OptimizationStats {
  folded: number;
  simplified: number;
  branchesRemoved: number;
  loopsRemoved: number;
  controlFlowRewrites: number;
}

export interface OptimizeResult {
  modules: Module[];
  stats: OptimizationStats;
}

export function emptyOptimizationStats(): OptimizationStats {
  return {
    folded: 0,
    simplified: 0,
    branchesRemoved: 0,
    loopsRemoved: 0,
    controlFlowRewrites: 0,
  };
}

type ConstExpr = Extract<Expr, { k: "const" }>;
type IfStmt = Extract<Stmt, { k: "if" }>;

function numberConst(expr: Expr): boolean {
  return expr.k === "const" && typeof expr.value === "number" && expr.type === "number";
}

class Optimizer {
  readonly stats = emptyOptimizationStats();
  private readonly options: Required<OptimizeOptions>;

  constructor(options: Required<OptimizeOptions>) {
    this.options = options;
  }

  private foldBinary(expr: Expr): Expr | undefined {
    if (expr.k !== "binary" || expr.l.k !== "const" || expr.r.k !== "const") return undefined;
    const left = expr.l.value as RuntimeValue;
    const right = expr.r.value as RuntimeValue;
    if (typeof left !== "number" || typeof right !== "number") return undefined;
    let value: number;
    switch (expr.op) {
      case "add": value = left + right; break;
      case "sub": value = left - right; break;
      case "mul": value = left * right; break;
      case "div": value = left / right; break;
      default: return undefined;
    }
    if (!Number.isFinite(value)) return undefined;
    return { ...expr, k: "const", type: "number", value };
  }

  private simplifyBinary(expr: Expr): Expr | undefined {
    if (expr.k !== "binary" || expr.l.type !== "number" || !numberConst(expr.r)) return undefined;
    const constant = (expr.r as ConstExpr).value;
    if ((expr.op === "add" || expr.op === "sub") && constant === 0) return expr.l;
    if ((expr.op === "mul" || expr.op === "div") && constant === 1) return expr.l;
    return undefined;
  }

  private foldUnary(expr: Expr): Expr | undefined {
    if (expr.k !== "unary" || expr.value.k !== "const") return undefined;
    const value = expr.value.value as RuntimeValue;
    if (expr.op === "not") {
      return { ...expr, k: "const", type: "boolean", value: !castToBoolean(value) };
    }
    if (typeof value !== "number") return undefined;
    const negated = -value;
    if (!Number.isFinite(negated)) return undefined;
    return { ...expr, k: "const", type: "number", value: negated };
  }

  private expr(expr: Expr): Expr {
    switch (expr.k) {
      case "binary": {
        const node: Expr = { ...expr, l: this.expr(expr.l), r: this.expr(expr.r) };
        if (this.options.folding) {
          const folded = this.foldBinary(node);
          if (folded) {
            this.stats.folded += 1;
            return folded;
          }
        }
        if (this.options.simplify) {
          const simplified = this.simplifyBinary(node);
          if (simplified) {
            this.stats.simplified += 1;
            return simplified;
          }
        }
        return node;
      }
      case "unary": {
        const node: Expr = { ...expr, value: this.expr(expr.value) };
        if (this.options.folding) {
          const folded = this.foldUnary(node);
          if (folded) {
            this.stats.folded += 1;
            return folded;
          }
        }
        return node;
      }
      case "convert": {
        const value = this.expr(expr.value);
        const node: Expr = { ...expr, value };
        if (this.options.folding && value.k === "const") {
          this.stats.folded += 1;
          return {
            ...node,
            k: "const",
            type: expr.to === "number" ? "number" : "boolean",
            value: expr.to === "number"
              ? castToNumber(value.value as RuntimeValue)
              : castToBoolean(value.value as RuntimeValue),
          };
        }
        if (this.options.simplify && value.k === "convert" && value.to === expr.to) {
          this.stats.simplified += 1;
          return value.value;
        }
        return node;
      }
      case "join": {
        let parts = expr.parts.map((part) => this.expr(part));
        if (this.options.simplify) {
          const merged: Expr[] = [];
          for (const part of parts) {
            const last = merged[merged.length - 1];
            if (last && last.k === "const" && part.k === "const"
              && typeof last.value === "string" && typeof part.value === "string") {
              merged[merged.length - 1] = { ...last, value: last.value + part.value };
              this.stats.simplified += 1;
            } else {
              merged.push(part);
            }
          }
          parts = merged;
        }
        if (this.options.folding && parts.every((part) => part.k === "const")) {
          this.stats.folded += 1;
          const text = parts
            .map((part) => castToString((part as ConstExpr).value as RuntimeValue))
            .join("");
          return { ...expr, k: "const", type: "string", value: text };
        }
        return { ...expr, parts };
      }
      case "intrinsic":
        return { ...expr, args: expr.args.map((argument) => this.expr(argument)) };
      case "listRead":
        return expr.index ? { ...expr, index: this.expr(expr.index) } : expr;
      case "arrayNew":
        return { ...expr, size: this.expr(expr.size) };
      case "arrayLength":
        return { ...expr, array: this.expr(expr.array) };
      case "fieldRead":
        return { ...expr, object: this.expr(expr.object) };
      case "arrayRead":
        return { ...expr, array: this.expr(expr.array), index: this.expr(expr.index) };
      case "methodCall":
        return {
          ...expr,
          object: this.expr(expr.object),
          args: expr.args.map((argument) => this.expr(argument)),
        };
      default:
        return expr;
    }
  }

  private statements(stmts: Stmt[]): Stmt[] {
    const result: Stmt[] = [];
    for (const stmt of stmts) {
      switch (stmt.k) {
        case "if": {
          const cond = this.expr(stmt.cond);
          const then = this.statements(stmt.then);
          const otherwise = stmt.else ? this.statements(stmt.else) : undefined;
          if (this.options.deadCode && cond.k === "const") {
            this.stats.branchesRemoved += 1;
            result.push(...(castToBoolean(cond.value as RuntimeValue) ? then : (otherwise ?? [])));
            break;
          }
          const node: IfStmt = { ...stmt, cond, then };
          if (otherwise) node.else = otherwise;
          result.push(node);
          break;
        }
        case "while": {
          const cond = this.expr(stmt.cond);
          if (this.options.deadCode && cond.k === "const"
            && !castToBoolean(cond.value as RuntimeValue)) {
            this.stats.loopsRemoved += 1;
            break;
          }
          result.push({ ...stmt, cond, body: this.statements(stmt.body) });
          break;
        }
        case "sequence":
          result.push({ ...stmt, body: this.statements(stmt.body) });
          break;
        case "declare":
          result.push(stmt.init ? { ...stmt, init: this.expr(stmt.init) } : stmt);
          break;
        case "assign":
          result.push({ ...stmt, value: this.expr(stmt.value) });
          break;
        case "expr":
        case "list":
        case "invoke":
          result.push({ ...stmt, args: stmt.args.map((argument) => this.expr(argument)) });
          break;
        case "heapArrayAllocate":
          result.push({ ...stmt, size: this.expr(stmt.size) });
          break;
        case "fieldWrite":
          result.push({ ...stmt, object: this.expr(stmt.object), value: this.expr(stmt.value) });
          break;
        case "arrayWrite":
          result.push({
            ...stmt,
            array: this.expr(stmt.array),
            index: this.expr(stmt.index),
            value: this.expr(stmt.value),
          });
          break;
        case "virtualInvoke":
          result.push({
            ...stmt,
            object: this.expr(stmt.object),
            args: stmt.args.map((argument) => this.expr(argument)),
          });
          break;
        case "heapAllocate":
          result.push(stmt);
          break;
        case "frameReturn":
          result.push({ ...stmt, value: this.expr(stmt.value) });
          break;
        case "heapFree":
          result.push({ ...stmt, object: this.expr(stmt.object) });
          break;
        case "return":
          result.push(stmt.value ? { ...stmt, value: this.expr(stmt.value) } : stmt);
          break;
        case "break":
        case "continue":
          result.push(stmt);
          break;
      }
    }
    return result;
  }

  module(module: Module): Module {
    return {
      ...module,
      scripts: module.scripts.map((script) => ({
        ...script,
        body: this.statements(script.body),
      })),
      ...(module.functions
        ? { functions: module.functions.map((fn) => ({ ...fn, body: this.statements(fn.body) })) }
        : {}),
    };
  }
}

export function optimizeModules(modules: Module[], options: OptimizeOptions = {}): OptimizeResult {
  const config: Required<OptimizeOptions> = {
    folding: options.folding ?? true,
    deadCode: options.deadCode ?? true,
    simplify: options.simplify ?? true,
  };
  const optimizer = new Optimizer(config);
  const optimized = modules.map((module) => optimizer.module(module));
  return { modules: optimized, stats: optimizer.stats };
}

export { lowerControlFlow } from "./control-flow.ts";
export type { ControlFlowResult, ControlFlowStats } from "./control-flow.ts";
