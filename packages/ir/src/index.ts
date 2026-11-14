import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";

export type IrType = "number" | "string" | "boolean" | "void";
export type VarId = string;
export type ListId = string;
export type BinOp =
  | "add" | "sub" | "mul" | "div" | "mod"
  | "lt" | "gt" | "le" | "ge" | "eq" | "ne"
  | "and" | "or";
export type ListOp = "push" | "insert" | "replace" | "deleteAt" | "clear";
export type ListReadOp = "length" | "item";

export interface VarDecl {
  id: VarId;
  name: string;
  type: IrType;
  storage: "global" | "local" | "temp";
  initial?: string | number | boolean;
  script?: number;
  span?: SourceSpan;
}

export interface ListDecl {
  id: ListId;
  name: string;
  type: IrType;
  initial?: (string | number | boolean)[];
  span?: SourceSpan;
}

export type Expr =
  | { k: "const"; value: string | number | boolean; type: IrType; span?: SourceSpan }
  | { k: "read"; var: VarId; type: IrType; span?: SourceSpan }
  | { k: "binary"; op: BinOp; l: Expr; r: Expr; type: IrType; span?: SourceSpan }
  | { k: "unary"; op: "not" | "neg"; value: Expr; type: IrType; span?: SourceSpan }
  | { k: "join"; parts: Expr[]; type: "string"; span?: SourceSpan }
  | { k: "convert"; to: "number" | "boolean"; value: Expr; type: IrType; span?: SourceSpan }
  | { k: "intrinsic"; name: string; args: Expr[]; type: IrType; span?: SourceSpan }
  | { k: "listRead"; op: ListReadOp; list: ListId; index?: Expr; type: IrType; span?: SourceSpan };

export type Stmt =
  | { k: "declare"; var: VarId; init?: Expr; span?: SourceSpan }
  | { k: "assign"; var: VarId; value: Expr; span?: SourceSpan }
  | { k: "expr"; name: string; args: Expr[]; span?: SourceSpan }
  | { k: "list"; op: ListOp; list: ListId; args: Expr[]; span?: SourceSpan }
  | { k: "break"; span?: SourceSpan }
  | { k: "continue"; span?: SourceSpan }
  | { k: "if"; cond: Expr; then: Stmt[]; else?: Stmt[]; span?: SourceSpan }
  | { k: "while"; cond: Expr; body: Stmt[]; span?: SourceSpan }
  | { k: "sequence"; body: Stmt[]; span?: SourceSpan };

export type Hat =
  | { kind: "flag" }
  | { kind: "key"; key: string }
  | { kind: "spriteClicked" }
  | { kind: "clone" }
  | { kind: "backdrop"; name: string }
  | { kind: "broadcast"; name: string };

export interface Script {
  hat: Hat;
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
  lists: ListDecl[];
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
    case "convert":
      yield* exprTree(expr.value);
      break;
    case "join":
      for (const part of expr.parts) yield* exprTree(part);
      break;
    case "intrinsic":
      for (const arg of expr.args) yield* exprTree(arg);
      break;
    case "listRead":
      if (expr.index) yield* exprTree(expr.index);
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
      case "list":
        for (const arg of stmt.args) yield* exprTree(arg);
        break;
      case "break":
      case "continue":
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

function* statementTree(stmts: Stmt[]): Generator<Stmt> {
  for (const stmt of stmts) {
    yield stmt;
    if (stmt.k === "if") {
      yield* statementTree(stmt.then);
      if (stmt.else) yield* statementTree(stmt.else);
    }
    if (stmt.k === "while") yield* statementTree(stmt.body);
    if (stmt.k === "sequence") yield* statementTree(stmt.body);
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
  const declared = new Map(module.vars.map((decl) => [decl.id, decl]));
  const declaredLists = new Set(module.lists.map((decl) => decl.id));
  const checkExpr = (expr: Expr): void => {
    for (const child of exprTree(expr)) {
      if (child.k === "read" && !declared.has(child.var)) {
        bag.error(CODES.UNSUPPORTED, `IR reads undeclared variable ${child.var}`, child.span);
      }
      if (child.k === "listRead" && !declaredLists.has(child.list)) {
        bag.error(CODES.UNSUPPORTED, `IR reads undeclared list ${child.list}`, child.span);
      }
    }
  };
  const checkStmts = (stmts: Stmt[], loopDepth: number): void => {
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
        case "list":
          if (!declaredLists.has(stmt.list)) {
            bag.error(CODES.UNSUPPORTED, `IR mutates undeclared list ${stmt.list}`, stmt.span);
          }
          for (const arg of stmt.args) checkExpr(arg);
          break;
        case "break":
        case "continue":
          if (loopDepth === 0) {
            bag.error(CODES.UNSUPPORTED, `${stmt.k} outside a loop`, stmt.span);
          }
          break;
        case "if":
          checkExpr(stmt.cond);
          if (stmt.cond.type !== "boolean") {
            bag.error(CODES.UNSUPPORTED, "if condition must be boolean", stmt.span);
          }
          checkStmts(stmt.then, loopDepth);
          if (stmt.else) checkStmts(stmt.else, loopDepth);
          break;
        case "while":
          checkExpr(stmt.cond);
          if (stmt.cond.type !== "boolean") {
            bag.error(CODES.UNSUPPORTED, "while condition must be boolean", stmt.span);
          }
          checkStmts(stmt.body, loopDepth + 1);
          break;
        case "sequence":
          checkStmts(stmt.body, loopDepth);
          break;
      }
    }
  };
  for (const decl of module.vars) {
    if (decl.type === "boolean") {
      bag.error(
        CODES.VARIABLE_TYPE,
        `Scratch variables cannot store boolean values (${decl.name})`,
        decl.span,
        ["Use a number (0/1) for flags; booleans are only valid as conditions and reporters."],
      );
    }
  }
  for (const script of module.scripts) checkStmts(script.body, 0);

  module.scripts.forEach((script, index) => {
    const checkPartition = (id: VarId, span?: SourceSpan): void => {
      const decl = declared.get(id);
      if (decl && decl.storage === "temp" && decl.script !== undefined && decl.script !== index) {
        bag.error(
          CODES.VARIABLE_SCOPE,
          `temporary ${decl.name} belongs to script ${decl.script} and cannot be used by script ${index}`,
          span,
          ["Temporaries are partitioned per hat script so concurrent scripts never clobber each other."],
        );
      }
    };
    for (const stmt of statementTree(script.body)) {
      if (stmt.k === "declare" || stmt.k === "assign") checkPartition(stmt.var, stmt.span);
    }
    for (const expr of stmtTree(script.body)) {
      if (expr.k === "read") checkPartition(expr.var, expr.span);
    }
  });
}

export { validateYieldBoundaries } from "./analysis.ts";
