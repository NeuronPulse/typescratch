import type {
  Expr, FunctionDecl, IrType, ListDecl, Module, Stmt, VarDecl,
} from "@typescratch/ir";

export interface ControlFlowStats {
  rewrites: number;
}

export interface ControlFlowResult {
  modules: Module[];
  stats: ControlFlowStats;
}

export const FRAME_RETURN_LIST_ID = "l_abi_frame_returnValue";

const FRAME_RETURN_LIST: ListDecl = {
  id: FRAME_RETURN_LIST_ID,
  name: "abi.frame.returnValue",
  type: "number",
  initial: [],
};

type WhileStmt = Extract<Stmt, { k: "while" }>;
type IfStmt = Extract<Stmt, { k: "if" }>;

function containsControlFlow(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmt.k === "break" || stmt.k === "continue") return true;
    if (stmt.k === "if") {
      if (containsControlFlow(stmt.then)) return true;
      if (stmt.else && containsControlFlow(stmt.else)) return true;
    }
    if (stmt.k === "sequence" && containsControlFlow(stmt.body)) return true;
  }
  return false;
}

const number = (value: number): Expr => ({ k: "const", value, type: "number" });
const read = (decl: VarDecl): Expr => ({ k: "read", var: decl.id, type: "number" });
const assign = (decl: VarDecl, value: Expr): Stmt => ({ k: "assign", var: decl.id, value });
const declare = (decl: VarDecl): Stmt => ({ k: "declare", var: decl.id, init: number(0) });

function guard(done: VarDecl, skip: VarDecl): Expr {
  return {
    k: "binary",
    op: "eq",
    l: { k: "binary", op: "add", l: read(done), r: read(skip), type: "number" },
    r: number(0),
    type: "boolean",
  };
}

function loopCondition(original: Expr, done: VarDecl): Expr {
  return {
    k: "binary",
    op: "eq",
    l: {
      k: "binary",
      op: "add",
      l: {
        k: "convert",
        to: "number",
        value: { k: "unary", op: "not", value: original, type: "boolean" },
        type: "number",
      },
      r: read(done),
      type: "number",
    },
    r: number(0),
    type: "boolean",
  };
}

class Rewriter {
  readonly vars: VarDecl[] = [];
  rewrites = 0;
  private counter = 0;
  private readonly moduleIndex: number;
  private readonly scriptIndex: number;

  constructor(moduleIndex: number, scriptIndex: number) {
    this.moduleIndex = moduleIndex;
    this.scriptIndex = scriptIndex;
  }

  private newVar(label: string): VarDecl {
    const index = ++this.counter;
    const decl: VarDecl = {
      id: `vcf_${this.moduleIndex}_${this.scriptIndex}_${index}`,
      name: `_tscr_s${this.scriptIndex}_cf${index}_${label}`,
      type: "number",
      storage: "temp",
      initial: 0,
      script: this.scriptIndex,
    };
    this.vars.push(decl);
    return decl;
  }

  private guardBody(stmts: Stmt[], done: VarDecl, skip: VarDecl): Stmt[] {
    const condition = guard(done, skip);
    return stmts.map((stmt) => ({
      k: "if" as const,
      cond: condition,
      then: [this.rewriteStmt(stmt, done, skip)],
    }));
  }

  private rewriteStmt(stmt: Stmt, done: VarDecl, skip: VarDecl): Stmt {
    switch (stmt.k) {
      case "break":
        return assign(done, number(1));
      case "continue":
        return assign(skip, number(1));
      case "if": {
        const node: IfStmt = { ...stmt };
        node.then = containsControlFlow(stmt.then)
          ? this.guardBody(stmt.then, done, skip)
          : this.rewriteStatements(stmt.then);
        if (stmt.else) {
          node.else = containsControlFlow(stmt.else)
            ? this.guardBody(stmt.else, done, skip)
            : this.rewriteStatements(stmt.else);
        }
        return node;
      }
      case "while": {
        const result = this.lowerLoop(stmt);
        return { k: "sequence", body: [...result.prefix, result.loop] };
      }
      case "sequence":
        return { ...stmt, body: this.rewriteStatements(stmt.body) };
      default:
        return stmt;
    }
  }

  private lowerLoop(stmt: WhileStmt): { prefix: Stmt[]; loop: Stmt } {
    const innerBody = this.rewriteStatements(stmt.body);
    if (!containsControlFlow(innerBody)) {
      return { prefix: [], loop: { ...stmt, body: innerBody } };
    }
    const done = this.newVar("done");
    const skip = this.newVar("skip");
    this.rewrites += 1;
    const body: Stmt[] = [
      assign(skip, number(0)),
      ...this.guardBody(innerBody, done, skip),
    ];
    return {
      prefix: [declare(done), declare(skip)],
      loop: { ...stmt, cond: loopCondition(stmt.cond, done), body },
    };
  }

  rewriteStatements(stmts: Stmt[]): Stmt[] {
    const result: Stmt[] = [];
    for (const stmt of stmts) {
      if (stmt.k === "while") {
        const lowered = this.lowerLoop(stmt);
        result.push(...lowered.prefix, lowered.loop);
      } else if (stmt.k === "if") {
        const node: IfStmt = { ...stmt, then: this.rewriteStatements(stmt.then) };
        if (stmt.else) node.else = this.rewriteStatements(stmt.else);
        result.push(node);
      } else if (stmt.k === "sequence") {
        result.push({ ...stmt, body: this.rewriteStatements(stmt.body) });
      } else {
        result.push(stmt);
      }
    }
    return result;
  }
}

function hasReturn(stmts: Stmt[]): boolean {
  return stmts.some((stmt) => {
    if (stmt.k === "return") return true;
    if (stmt.k === "if") return hasReturn(stmt.then) || (stmt.else ? hasReturn(stmt.else) : false);
    if (stmt.k === "while" || stmt.k === "sequence") return hasReturn(stmt.body);
    return false;
  });
}

function rewriteReturns(fn: FunctionDecl, body: Stmt[]): Stmt[] {
  const condition: Expr = {
    k: "binary",
    op: "eq",
    l: { k: "read", var: fn.returning, type: "number" },
    r: number(0),
    type: "boolean",
  };
  function rewriteStmt(stmt: Stmt): Stmt {
    if (stmt.k === "return") {
      const assigns: Stmt[] = [
        { k: "assign", var: fn.returning, value: number(1), span: stmt.span },
      ];
      if (stmt.value) assigns.push({ k: "assign", var: fn.returnValue, value: stmt.value, span: stmt.span });
      return { k: "sequence", body: assigns, span: stmt.span };
    }
    if (stmt.k === "if") {
      return {
        ...stmt,
        then: rewriteStmts(stmt.then),
        ...(stmt.else ? { else: rewriteStmts(stmt.else) } : {}),
      };
    }
    if (stmt.k === "while") return { ...stmt, body: rewriteStmts(stmt.body) };
    if (stmt.k === "sequence") return { ...stmt, body: rewriteStmts(stmt.body) };
    return stmt;
  }
  function rewriteStmts(stmts: Stmt[]): Stmt[] {
    return stmts.map((stmt) => ({ k: "if", cond: condition, then: [rewriteStmt(stmt)], span: stmt.span }));
  }
  const guarded = hasReturn(body) ? rewriteStmts(body) : body;
  return [
    { k: "assign", var: fn.returning, value: number(0) },
    { k: "assign", var: fn.returnValue, value: number(0) },
    ...guarded,
    {
      k: "frameReturn",
      value: { k: "read", var: fn.returnValue, type: fn.returnType },
      list: FRAME_RETURN_LIST_ID,
      callId: fn.callId,
      tag: fn.returnType === "string" ? "s" : fn.returnType === "boolean" ? "b" : fn.returnType === "void" ? "u" : "n",
    },
  ];
}

export function lowerControlFlow(modules: Module[]): ControlFlowResult {
  let rewrites = 0;
  const result = modules.map((module, moduleIndex) => {
    const vars = [...module.vars];
    const lists = [...module.lists];
    const functions = module.functions ?? [];
    let callCounter = 0;

    const makeVars = (
      scriptIndex: number,
      type: IrType,
    ): { callId: VarDecl; result: VarDecl; resultTag: VarDecl } => {
      const index = ++callCounter;
      const callId: VarDecl = {
        id: `vcall_${moduleIndex}_${scriptIndex}_${index}_id`,
        name: `_tscr_s${scriptIndex}_call${index}_id`,
        type: "number",
        storage: "temp",
        initial: 0,
        script: scriptIndex,
      };
      const resultVar: VarDecl = {
        id: `vcall_${moduleIndex}_${scriptIndex}_${index}_ret`,
        name: `_tscr_s${scriptIndex}_call${index}_ret`,
        type,
        storage: "temp",
        initial: 0,
        script: scriptIndex,
      };
      const resultTag: VarDecl = {
        id: `vcall_${moduleIndex}_${scriptIndex}_${index}_tag`,
        name: `_tscr_s${scriptIndex}_call${index}_tag`,
        type: "string",
        storage: "temp",
        initial: "",
        script: scriptIndex,
      };
      vars.push(callId, resultVar, resultTag);
      return { callId, result: resultVar, resultTag };
    };

    const liftExpr = (expr: Expr, prelude: Stmt[], scriptIndex: number): Expr => {
      switch (expr.k) {
        case "call": {
          const args = expr.args.map((arg) => liftExpr(arg, prelude, scriptIndex));
          const { callId, result, resultTag } = makeVars(scriptIndex, expr.type);
          prelude.push({
            k: "invoke", function: expr.function, args,
            callId: callId.id, result: result.id, resultTag: resultTag.id, span: expr.span,
          });
          return { k: "read", var: result.id, type: expr.type, span: expr.span };
        }
        case "objectNew": {
          const { result } = makeVars(scriptIndex, "number");
          prelude.push({
            k: "heapAllocate", classId: expr.classId, result: result.id, span: expr.span,
          });
          return { k: "read", var: result.id, type: "number", span: expr.span };
        }
        case "arrayNew": {
          const size = liftExpr(expr.size, prelude, scriptIndex);
          const { result } = makeVars(scriptIndex, "number");
          prelude.push({ k: "heapArrayAllocate", size, result: result.id, span: expr.span });
          return { k: "read", var: result.id, type: "number", span: expr.span };
        }
        case "methodCall": {
          const object = liftExpr(expr.object, prelude, scriptIndex);
          const args = expr.args.map((arg) => liftExpr(arg, prelude, scriptIndex));
          const { callId, result, resultTag } = makeVars(scriptIndex, expr.type);
          prelude.push({
            k: "virtualInvoke",
            object,
            method: expr.method,
            args,
            callId: callId.id,
            result: result.id,
            resultTag: resultTag.id,
            targets: expr.targets,
            span: expr.span,
          });
          return { k: "read", var: result.id, type: expr.type, span: expr.span };
        }
        case "binary":
          return { ...expr, l: liftExpr(expr.l, prelude, scriptIndex), r: liftExpr(expr.r, prelude, scriptIndex) };
        case "unary":
        case "convert":
          return { ...expr, value: liftExpr(expr.value, prelude, scriptIndex) };
        case "join":
          return { ...expr, parts: expr.parts.map((part) => liftExpr(part, prelude, scriptIndex)) };
        case "intrinsic":
          return { ...expr, args: expr.args.map((arg) => liftExpr(arg, prelude, scriptIndex)) };
        case "listRead":
          return expr.index ? { ...expr, index: liftExpr(expr.index, prelude, scriptIndex) } : expr;
        default:
          return expr;
      }
    };

    const liftStmts = (stmts: Stmt[], scriptIndex: number): Stmt[] => {
      const out: Stmt[] = [];
      for (const stmt of stmts) {
        const prelude: Stmt[] = [];
        const lift = (expr: Expr): Expr => liftExpr(expr, prelude, scriptIndex);
        let next: Stmt;
        switch (stmt.k) {
          case "declare":
            next = stmt.init ? { ...stmt, init: lift(stmt.init) } : stmt;
            break;
          case "assign":
            next = { ...stmt, value: lift(stmt.value) };
            break;
          case "frameReturn":
            next = { ...stmt, value: lift(stmt.value) };
            break;
          case "expr":
          case "list":
          case "invoke":
            next = { ...stmt, args: stmt.args.map(lift) };
            break;
          case "virtualInvoke":
            next = { ...stmt, object: lift(stmt.object), args: stmt.args.map(lift) };
            break;
          case "heapArrayAllocate":
            next = { ...stmt, size: lift(stmt.size) };
            break;
          case "heapFree":
            next = { ...stmt, object: lift(stmt.object) };
            break;
          case "fieldWrite":
            next = { ...stmt, object: lift(stmt.object), value: lift(stmt.value) };
            break;
          case "arrayWrite":
            next = {
              ...stmt,
              array: lift(stmt.array),
              index: lift(stmt.index),
              value: lift(stmt.value),
            };
            break;
          case "heapAllocate":
            next = stmt;
            break;
          case "return":
            next = stmt.value ? { ...stmt, value: lift(stmt.value) } : stmt;
            break;
          case "if": {
            const cond = lift(stmt.cond);
            const then = liftStmts(stmt.then, scriptIndex);
            const elseBody = stmt.else ? liftStmts(stmt.else, scriptIndex) : undefined;
            next = { ...stmt, cond, then, ...(elseBody ? { else: elseBody } : {}) };
            break;
          }
          case "while":
            next = { ...stmt, cond: lift(stmt.cond), body: liftStmts(stmt.body, scriptIndex) };
            break;
          case "sequence":
            next = { ...stmt, body: liftStmts(stmt.body, scriptIndex) };
            break;
          default:
            next = stmt;
        }
        out.push(...prelude, next);
      }
      return out;
    };

    const scripts = module.scripts.map((script, scriptIndex) => {
      const body = liftStmts(script.body, scriptIndex);
      const rewriter = new Rewriter(moduleIndex, scriptIndex);
      const lowered = rewriter.rewriteStatements(body);
      vars.push(...rewriter.vars);
      rewrites += rewriter.rewrites;
      return { ...script, body: lowered };
    });
    const loweredFunctions = functions.map((fn) => ({ ...fn, body: rewriteReturns(fn, liftStmts(fn.body, -1)) }));
    if (loweredFunctions.length > 0 && !lists.some((list) => list.id === FRAME_RETURN_LIST_ID)) {
      lists.push(FRAME_RETURN_LIST);
    }
    return {
      ...module,
      vars,
      lists,
      scripts,
      ...(functions.length > 0 ? { functions: loweredFunctions } : {}),
    };
  });
  return { modules: result, stats: { rewrites } };
}
