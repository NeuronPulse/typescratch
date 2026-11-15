import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import { getIntrinsic } from "@typescratch/language";
import type { Expr, Module, Stmt, VarId } from "./index.ts";

interface YieldEvent {
  kind: "write" | "read" | "yield";
  var?: VarId;
  span?: SourceSpan;
}

function expressionEvents(expr: Expr): YieldEvent[] {
  const events: YieldEvent[] = [];
  const visit = (node: Expr): void => {
    switch (node.k) {
      case "read":
        events.push({ kind: "read", var: node.var, span: node.span });
        break;
      case "binary":
        visit(node.l);
        visit(node.r);
        break;
      case "unary":
      case "convert":
        visit(node.value);
        break;
      case "join":
        for (const part of node.parts) visit(part);
        break;
      case "call":
        for (const arg of node.args) visit(arg);
        break;
      case "intrinsic":
        for (const arg of node.args) visit(arg);
        if (getIntrinsic(node.name)?.effect === "yields") {
          events.push({ kind: "yield", span: node.span });
        }
        break;
      case "listRead":
        if (node.index) visit(node.index);
        break;
      case "arrayNew":
        visit(node.size);
        break;
      case "arrayLength":
        visit(node.array);
        break;
      case "fieldRead":
        visit(node.object);
        break;
      case "arrayRead":
        visit(node.array);
        visit(node.index);
        break;
      case "methodCall":
        visit(node.object);
        for (const arg of node.args) visit(arg);
        break;
      case "objectNew":
      case "const":
        break;
    }
  };
  visit(expr);
  return events;
}

function statementEvents(stmts: Stmt[]): YieldEvent[] {
  const events: YieldEvent[] = [];
  const visit = (list: Stmt[]): void => {
    for (const stmt of list) {
      switch (stmt.k) {
        case "declare":
          if (stmt.init) events.push(...expressionEvents(stmt.init));
          events.push({ kind: "write", var: stmt.var, span: stmt.span });
          break;
        case "assign":
          events.push(...expressionEvents(stmt.value));
          events.push({ kind: "write", var: stmt.var, span: stmt.span });
          break;
        case "invoke":
        case "virtualInvoke":
          if (stmt.k === "virtualInvoke") events.push(...expressionEvents(stmt.object));
          for (const arg of stmt.args) events.push(...expressionEvents(arg));
          events.push({ kind: "write", var: stmt.callId, span: stmt.span });
          events.push({ kind: "write", var: stmt.result, span: stmt.span });
          events.push({ kind: "write", var: stmt.resultTag, span: stmt.span });
          break;
        case "heapAllocate":
          events.push({ kind: "write", var: stmt.result, span: stmt.span });
          break;
        case "heapArrayAllocate":
          events.push(...expressionEvents(stmt.size));
          events.push({ kind: "write", var: stmt.result, span: stmt.span });
          break;
        case "fieldWrite":
          events.push(...expressionEvents(stmt.object));
          events.push(...expressionEvents(stmt.value));
          break;
        case "arrayWrite":
          events.push(...expressionEvents(stmt.array));
          events.push(...expressionEvents(stmt.index));
          events.push(...expressionEvents(stmt.value));
          break;
        case "frameReturn":
          events.push(...expressionEvents(stmt.value));
          break;
        case "return":
          if (stmt.value) events.push(...expressionEvents(stmt.value));
          break;
        case "expr":
          for (const arg of stmt.args) events.push(...expressionEvents(arg));
          if (getIntrinsic(stmt.name)?.effect === "yields") {
            events.push({ kind: "yield", span: stmt.span });
          }
          break;
        case "list":
          for (const arg of stmt.args) events.push(...expressionEvents(arg));
          break;
        case "break":
        case "continue":
          break;
        case "if":
          events.push(...expressionEvents(stmt.cond));
          visit(stmt.then);
          if (stmt.else) visit(stmt.else);
          break;
        case "while":
          events.push(...expressionEvents(stmt.cond));
          visit(stmt.body);
          break;
        case "sequence":
          visit(stmt.body);
          break;
      }
    }
  };
  visit(stmts);
  return events;
}

export function validateYieldBoundaries(module: Module, bag: DiagnosticBag): void {
  const temps = new Set(
    module.vars.filter((decl) => decl.storage === "temp").map((decl) => decl.id),
  );
  for (const script of module.scripts) {
    const events = statementEvents(script.body);
    const yieldIndex = events.findIndex((event) => event.kind === "yield");
    if (yieldIndex < 0) continue;
    const liveBeforeYield = new Set<VarId>();
    for (const event of events.slice(0, yieldIndex)) {
      if (event.kind === "write" && event.var && temps.has(event.var)) liveBeforeYield.add(event.var);
    }
    for (const event of events.slice(yieldIndex + 1)) {
      if (event.kind !== "read" || !event.var || !temps.has(event.var)) continue;
      if (!liveBeforeYield.has(event.var)) continue;
      liveBeforeYield.delete(event.var);
      const decl = module.vars.find((item) => item.id === event.var);
      bag.error(
        CODES.YIELD,
        `temporary ${decl?.name ?? event.var} is read across a yielding call`,
        event.span,
        [
          "Scratch suspends the thread at wait/broadcast/extension calls; another script may overwrite this temporary.",
          "Store the value in a named global/local resource or avoid reading it after the yield.",
        ],
      );
    }
  }
}
