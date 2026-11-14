import type { Expr, Module, Stmt, VarDecl } from "@typescratch/ir";

export interface ControlFlowStats {
  rewrites: number;
}

export interface ControlFlowResult {
  modules: Module[];
  stats: ControlFlowStats;
}

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

export function lowerControlFlow(modules: Module[]): ControlFlowResult {
  let rewrites = 0;
  const result = modules.map((module, moduleIndex) => {
    const vars = [...module.vars];
    const scripts = module.scripts.map((script, scriptIndex) => {
      const rewriter = new Rewriter(moduleIndex, scriptIndex);
      const body = rewriter.rewriteStatements(script.body);
      vars.push(...rewriter.vars);
      rewrites += rewriter.rewrites;
      return { ...script, body };
    });
    return { ...module, vars, scripts };
  });
  return { modules: result, stats: { rewrites } };
}
