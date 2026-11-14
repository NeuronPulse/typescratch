import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";

export type IrType = "number" | "string" | "boolean" | "void";
export type VarId = string;
export type BinOp =
  | "add" | "sub" | "mul" | "div" | "mod"
  | "lt" | "gt" | "le" | "ge" | "eq" | "ne"
  | "and" | "or";

export interface VarDecl {
  id: VarId;
  name: string;
  type: IrType;
  storage: "global" | "local" | "temp";
  initial?: string | number | boolean;
  span?: SourceSpan;
}

export type Expr =
  | { k: "const"; value: string | number | boolean; type: IrType; span?: SourceSpan }
  | { k: "read"; var: VarId; type: IrType; span?: SourceSpan }
  | { k: "binary"; op: BinOp; l: Expr; r: Expr; type: IrType; span?: SourceSpan }
  | { k: "unary"; op: "not" | "neg"; value: Expr; type: IrType; span?: SourceSpan }
  | { k: "join"; parts: Expr[]; type: "string"; span?: SourceSpan }
  | { k: "intrinsic"; name: string; args: Expr[]; type: IrType; span?: SourceSpan };

export type Stmt =
  | { k: "declare"; var: VarId; init?: Expr; span?: SourceSpan }
  | { k: "assign"; var: VarId; value: Expr; span?: SourceSpan }
  | { k: "expr"; name: string; args: Expr[]; span?: SourceSpan }
  | { k: "if"; cond: Expr; then: Stmt[]; else?: Stmt[]; span?: SourceSpan }
  | { k: "while"; cond: Expr; body: Stmt[]; span?: SourceSpan }
  | { k: "sequence"; body: Stmt[]; span?: SourceSpan };

export interface Script {
  hat: "flag";
  body: Stmt[];
  span?: SourceSpan;
}

export interface RoleRef {
  name: string;
  isStage: boolean;
}

export interface Module {
  entry: string;
  scripts: Script[];
  vars: VarDecl[];
  role?: RoleRef;
}

export function printModule(module: Module): string {
  return JSON.stringify(module, null, 2);
}

function* exprTree(expr: Expr): Generator<Expr> {
  yield expr;
  switch (expr.k) {
    case "binary":
      yield* exprTree(expr.l);
      yield* exprTree(expr.r);
      break;
    case "unary":
      yield* exprTree(expr.value);
      break;
    case "join":
      for (const part of expr.parts) yield* exprTree(part);
      break;
    case "intrinsic":
      for (const arg of expr.args) yield* exprTree(arg);
      break;
    default:
      break;
  }
}

function* stmtTree(stmts: Stmt[]): Generator<Expr> {
  for (const stmt of stmts) {
    switch (stmt.k) {
      case "declare":
        if (stmt.init) yield* exprTree(stmt.init);
        break;
      case "assign":
        yield* exprTree(stmt.value);
        break;
      case "expr":
        for (const arg of stmt.args) yield* exprTree(arg);
        break;
      case "if":
        yield* exprTree(stmt.cond);
        yield* stmtTree(stmt.then);
        if (stmt.else) yield* stmtTree(stmt.else);
        break;
      case "while":
        yield* exprTree(stmt.cond);
        yield* stmtTree(stmt.body);
        break;
      case "sequence":
        yield* stmtTree(stmt.body);
        break;
    }
  }
}

export function* allExprs(module: Module): Generator<Expr> {
  for (const script of module.scripts) yield* stmtTree(script.body);
}

export function* allCommands(module: Module): Generator<{ name: string; span?: SourceSpan }> {
  const visit = function* (stmts: Stmt[]): Generator<{ name: string; span?: SourceSpan }> {
    for (const stmt of stmts) {
      if (stmt.k === "expr") yield { name: stmt.name, span: stmt.span };
      if (stmt.k === "if") {
        yield* visit(stmt.then);
        if (stmt.else) yield* visit(stmt.else);
      }
      if (stmt.k === "while") yield* visit(stmt.body);
      if (stmt.k === "sequence") yield* visit(stmt.body);
    }
  };
  for (const script of module.scripts) yield* visit(script.body);
}

export function validateModule(module: Module, bag: DiagnosticBag): void {
  const declared = new Set(module.vars.map((decl) => decl.id));
  const checkExpr = (expr: Expr): void => {
    for (const child of exprTree(expr)) {
      if (child.k === "read" && !declared.has(child.var)) {
        bag.error(CODES.UNSUPPORTED, `IR reads undeclared variable ${child.var}`, child.span);
      }
    }
  };
  const checkStmts = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.k) {
        case "declare":
          if (!declared.has(stmt.var)) {
            bag.error(CODES.UNSUPPORTED, `IR declares unknown variable ${stmt.var}`, stmt.span);
          }
          if (stmt.init) checkExpr(stmt.init);
          break;
        case "assign":
          if (!declared.has(stmt.var)) {
            bag.error(CODES.UNSUPPORTED, `IR assigns unknown variable ${stmt.var}`, stmt.span);
          }
          checkExpr(stmt.value);
          break;
        case "expr":
          for (const arg of stmt.args) checkExpr(arg);
          break;
        case "if":
          checkExpr(stmt.cond);
          if (stmt.cond.type !== "boolean") {
            bag.error(CODES.UNSUPPORTED, "if condition must be boolean", stmt.span);
          }
          checkStmts(stmt.then);
          if (stmt.else) checkStmts(stmt.else);
          break;
        case "while":
          checkExpr(stmt.cond);
          if (stmt.cond.type !== "boolean") {
            bag.error(CODES.UNSUPPORTED, "while condition must be boolean", stmt.span);
          }
          checkStmts(stmt.body);
          break;
        case "sequence":
          checkStmts(stmt.body);
          break;
      }
    }
  };
  for (const script of module.scripts) checkStmts(script.body);
}
