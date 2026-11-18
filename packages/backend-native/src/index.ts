import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import {
  GraphBuilder,
  defaultCostume,
  type BlockId,
  type Field,
  type InputRef,
  type Primitive,
  type ProjectGraph,
  type RoleDecl,
} from "@typescratch/graph";
import type { BinOp, Expr, FunctionDecl, FunctionId, Hat, ListOp, Module, Stmt, VarDecl, VarId } from "@typescratch/ir";
import { getIntrinsic } from "@typescratch/language";
import { type FrameLayout } from "./frame-blocks.ts";
import { nativeFrameStore, type FrameStore } from "./frame-store.ts";
import {
  declareStringEqTemps,
  emitStringEqInline,
  resetStringEqCounter,
  stringEqHelperRole,
} from "./string-equality.ts";
import {
  declareHeapLayout,
  emitHeapAllocate,
  emitHeapArrayAllocate,
  emitHeapArrayLength,
  emitHeapArrayRead,
  emitHeapClassOf,
  emitHeapFieldRead,
  emitHeapRelease,
  type HeapLayout,
} from "./heap-blocks.ts";

export * from "./heap-blocks.ts";

const HAT_OPCODES: Record<Hat["kind"], string> = {
  flag: "event_whenflagclicked",
  key: "event_whenkeypressed",
  spriteClicked: "event_whenthisspriteclicked",
  clone: "control_start_as_clone",
  backdrop: "event_whenbackdropswitchesto",
  broadcast: "event_whenbroadcastreceived",
  greaterThan: "event_whengreaterthan",
};

function hatFields(hat: Hat, broadcastId: (name: string) => string): Record<string, Field> | undefined {
  switch (hat.kind) {
    case "key": return { KEY_OPTION: [hat.key, null] };
    case "backdrop": return { BACKDROP: [hat.name, null] };
    case "broadcast": return { BROADCAST_OPTION: [hat.name, broadcastId(hat.name)] };
    default: return undefined;
  }
}

const BINARY_OPCODES: Partial<Record<BinOp, string>> = {
  add: "operator_add",
  sub: "operator_subtract",
  mul: "operator_multiply",
  div: "operator_divide",
  mod: "operator_mod",
  lt: "operator_lt",
  gt: "operator_gt",
  eq: "operator_equals",
};

const LIST_OPCODES: Record<ListOp, string> = {
  push: "data_addtolist",
  insert: "data_insertatlist",
  replace: "data_replaceitemoflist",
  deleteAt: "data_deleteoflist",
  clear: "data_deletealloflist",
};

const BOOLEAN_OPS: ReadonlySet<BinOp> = new Set(["lt", "gt", "eq"]);

export interface NativeLoweringOptions {
  extensionOpcodes?: Map<string, string>;
  extensionInputs?: Map<string, string[]>;
  roles?: RoleDecl[];
  frameStore?: FrameStore;
}

export interface NativeLoweringResult {
  graph: ProjectGraph;
  builder: GraphBuilder;
}

interface ProcedureInfo {
  proccode: string;
  argIds: string[];
  argNames: string[];
  defaults: string[];
  callIdArg: string;
  warp: boolean;
}

function initialValue(decl: VarDecl): string | number | boolean {
  if (decl.initial !== undefined) return decl.initial;
  if (decl.type === "string") return "";
  if (decl.type === "boolean") return false;
  return 0;
}

function oneBased(index: Expr): Expr {
  return {
    k: "binary",
    op: "add",
    l: index,
    r: { k: "const", value: 1, type: "number" },
    type: "number",
  };
}

function listField(name: string, id: string): Record<string, Field> {
  return { LIST: [name, id] };
}

export * from "./frame-blocks.ts";
export * from "./frame-store.ts";
export * from "./extension-frame-store.ts";

function usesStrictStringEq(modules: readonly Module[]): boolean {
  const visitExpr = (expr: Expr): boolean => {
    switch (expr.k) {
      case "abstractEq": return expr.strictStrings === true || visitExpr(expr.l) || visitExpr(expr.r);
      case "binary": return visitExpr(expr.l) || visitExpr(expr.r);
      case "unary":
      case "convert": return visitExpr(expr.value);
      case "join": return expr.parts.some(visitExpr);
      case "intrinsic": return expr.args.some(visitExpr);
      case "listRead": return expr.index ? visitExpr(expr.index) : false;
      case "call": return expr.args.some(visitExpr);
      case "arrayNew": return visitExpr(expr.size);
      case "fieldRead": return visitExpr(expr.object);
      case "arrayRead": return visitExpr(expr.array) || visitExpr(expr.index);
      case "arrayLength": return visitExpr(expr.array);
      case "methodCall": return visitExpr(expr.object) || expr.args.some(visitExpr);
      default: return false;
    }
  };
  const visitStmts = (stmts: readonly Stmt[]): boolean => stmts.some((stmt) => {
    switch (stmt.k) {
      case "declare": return stmt.init ? visitExpr(stmt.init) : false;
      case "assign":
      case "frameReturn":
      case "raise": return visitExpr(stmt.value);
      case "expr":
      case "list":
      case "invoke": return stmt.args.some(visitExpr);
      case "virtualInvoke": return visitExpr(stmt.object) || stmt.args.some(visitExpr);
      case "heapArrayAllocate": return visitExpr(stmt.size);
      case "heapFree": return stmt.object ? visitExpr(stmt.object) : false;
      case "fieldWrite": return visitExpr(stmt.object) || visitExpr(stmt.value);
      case "arrayWrite": return visitExpr(stmt.array) || visitExpr(stmt.index) || visitExpr(stmt.value);
      case "return": return stmt.value ? visitExpr(stmt.value) : false;
      case "if": return visitExpr(stmt.cond) || visitStmts(stmt.then) || (stmt.else ? visitStmts(stmt.else) : false);
      case "while": return visitExpr(stmt.cond) || visitStmts(stmt.body);
      case "sequence": return visitStmts(stmt.body);
      case "tryCall": return visitStmts(stmt.body) || visitStmts(stmt.handler);
      default: return false;
    }
  });
  return modules.some((module) =>
    module.scripts.some((script) => visitStmts(script.body))
    || (module.functions ?? []).some((fn) => visitStmts(fn.body)));
}

export function lowerNative(
  input: Module | Module[],
  bag: DiagnosticBag,
  options: NativeLoweringOptions = {},
): NativeLoweringResult {
  const modules = Array.isArray(input) ? input : [input];
  resetStringEqCounter();
  const needsStringEq = usesStrictStringEq(modules);
  const roles: RoleDecl[] = [...(options.roles ?? [])].map((role) => ({ ...role }));
  // createProject() only synthesizes a default sprite when no non-stage role
  // exists. Ensure the default "Sprite1" that user code emits into exists.
  if (!roles.some((role) => !role.isStage)) {
    roles.push({ name: "Sprite1", isStage: false });
  }
  // Scratch custom procedures are sprite-local: the helper procedure and its
  // 53 probe costumes must live on the sprite that CALLS them. Attach them to
  // the first non-stage role (single-sprite projects — the common case).
  if (needsStringEq) {
    const host = roles.find((role) => !role.isStage)!;
    const helper = stringEqHelperRole();
    host.costumes = [...(host.costumes ?? [defaultCostume(false)]), ...helper.costumes!];
  }
  const builder = new GraphBuilder(roles);
  const variables = new Map(modules.flatMap((module) => module.vars).map((decl) => [decl.id, decl]));
  const functions = new Map<FunctionId, FunctionDecl>();
  const procedureInfo = new Map<FunctionId, ProcedureInfo>();
  const paramNames = new Map<VarId, { name: string; boolean: boolean }>();
  /** Function state lives in frame slots, not in persistent Scratch variables: recursion needs this. */
  const frameStateVars = new Map<VarId, { list: string; callId: VarId }>();

  const firstTarget = builder.project.targets.find((target) => !target.isStage)?.name
    ?? builder.project.targets[0]!.name;
  if (needsStringEq) {
    // Shared probe temporaries live on the calling sprite (costumes are there).
    builder.setActiveTarget(firstTarget);
    declareStringEqTemps(builder);
  }
  builder.setActiveTarget(firstTarget);

  for (const module of modules) {
    for (const fn of module.functions ?? []) {
      functions.set(fn.id, fn);
      const argIds = [...fn.params.map((_, index) => `input${index}`), "inputCallId"];
      const callIdName = variables.get(fn.callId)?.name ?? "callId";
      const argNames = [...fn.params.map((param) => param.name), callIdName];
      const procedureLabel = fn.classId ? `${fn.classId}.${fn.name}` : fn.name;
      procedureInfo.set(fn.id, {
        proccode: `${procedureLabel} ${argIds.map(() => "%s").join(" ")}`,
        argIds,
        argNames,
        defaults: argIds.map(() => ""),
        callIdArg: "inputCallId",
        warp: fn.warp === true,
      });
      for (const param of fn.params) {
        paramNames.set(param.id, { name: param.name, boolean: param.type === "boolean" });
      }
      paramNames.set(fn.callId, { name: callIdName, boolean: false });
      frameStateVars.set(fn.returning, { list: "abi.frame.returning", callId: fn.callId });
      frameStateVars.set(fn.returnValue, { list: "abi.frame.returnValue", callId: fn.callId });
    }
  }

  for (const module of modules) {
    builder.setActiveTarget(module.role?.name ?? "Sprite1");
    for (const decl of module.vars) {
      builder.declareVariable(decl.id, decl.name, initialValue(decl), decl.storage);
    }
    for (const decl of module.lists ?? []) {
      builder.declareList(
        decl.id, decl.name, decl.initial ?? [],
        decl.name.startsWith("abi.frame.") ? "global" : "local",
      );
    }
  }

  builder.setActiveTarget(modules[0]?.role?.name ?? "Sprite1");
  const frameStore: FrameStore = options.frameStore ?? nativeFrameStore;
  const layout: FrameLayout | undefined = functions.size > 0
    ? frameStore.declareLayout(builder)
    : undefined;

  const classById = new Map(
    modules.flatMap((module) => (module.classes ?? []).map((entry) => [entry.id, entry] as const)),
  );
  const heapFieldNames = [
    ...new Set(
      modules.flatMap((module) =>
        (module.classes ?? []).flatMap((entry) => entry.fields.map((field) => field.name))),
    ),
  ].sort();
  const heapInitials: Record<string, string> = {};
  for (const module of modules) {
    for (const entry of module.classes ?? []) {
      for (const field of entry.fields) {
        heapInitials[field.name] = String(field.initial ?? (field.type === "string" ? "" : 0));
      }
    }
  }
  const heapUsed = (() => {
    const visit = (stmts: Stmt[]): boolean => stmts.some((stmt) => {
      switch (stmt.k) {
        case "heapAllocate":
        case "heapArrayAllocate":
        case "fieldWrite":
        case "arrayWrite":
        case "virtualInvoke":
          return true;
        case "if":
          return visit(stmt.then) || (stmt.else ? visit(stmt.else) : false);
        case "while":
        case "sequence":
          return visit(stmt.body);
        default:
          return false;
      }
    });
    return modules.some((module) =>
      module.scripts.some((script) => visit(script.body))
      || (module.functions ?? []).some((fn) => visit(fn.body)));
  })();
  const heapLayout: HeapLayout | undefined = heapUsed
    ? declareHeapLayout(builder, heapFieldNames, heapInitials)
    : undefined;

  // Statements required by expression lowering (Scratch calls are statements,
  // so a strict string equality cannot be a reporter). Drained by
  // emitStatements before each statement.
  const stringEqPreludeStack: BlockId[][] = [];

  const emitValue = (expr: Expr, owner: string, scope: string, fallback?: SourceSpan): InputRef => {
    const span = expr.span ?? fallback;
    switch (expr.k) {
      case "const": {
        if (expr.type === "boolean") {
          const id = builder.add("operator_equals", { scope, parent: owner, span });
          builder.input(id, "OPERAND1", { primitive: [4, "1"] });
          builder.input(id, "OPERAND2", { primitive: [4, expr.value ? "1" : "0"] });
          return { block: id };
        }
        const primitive: Primitive = expr.type === "number"
          ? [4, String(expr.value)]
          : [10, String(expr.value)];
        return { primitive };
      }
      case "read": {
        const state = frameStateVars.get(expr.var);
        const listRef = state ? layout?.lists[state.list] : undefined;
        if (state && listRef) {
          const item = builder.add("data_itemoflist", {
            scope, parent: owner, span,
            fields: { LIST: [listRef.name, listRef.id] },
          });
          const index = builder.add("operator_add", { scope, parent: item, span });
          builder.input(index, "NUM1", emitValue(
            { k: "read", var: state.callId, type: "number", span }, index, scope, span,
          ));
          builder.input(index, "NUM2", { primitive: [4, "1"] });
          builder.input(item, "INDEX", { block: index });
          return { block: item };
        }
        const param = paramNames.get(expr.var);
        if (param) {
          const id = builder.add(
            param.boolean ? "argument_reporter_boolean" : "argument_reporter_string_number",
            { scope, parent: owner, span, fields: { VALUE: [param.name, null] } },
          );
          return { block: id };
        }
        return { obscuredPrimitive: [12, builder.variableName(expr.var), expr.var] };
      }
      case "unary": {
        if (expr.op === "not") {
          const id = builder.add("operator_not", { scope, parent: owner, span });
          builder.input(id, "OPERAND", emitValue(expr.value, id, scope, span));
          return { block: id };
        }
        const id = builder.add("operator_subtract", { scope, parent: owner, span });
        builder.input(id, "NUM1", { primitive: [4, "0"] });
        builder.input(id, "NUM2", emitValue(expr.value, id, scope, span));
        return { block: id };
      }
      case "join": {
        const first = expr.parts[0];
        if (!first) return { primitive: [10, ""] };
        let accumulated = emitValue(first, owner, scope, span);
        for (let index = 1; index < expr.parts.length; index++) {
          const id = builder.add("operator_join", { scope, parent: owner, span });
          builder.input(id, "STRING1", accumulated);
          builder.input(id, "STRING2", emitValue(expr.parts[index]!, id, scope, span));
          accumulated = { block: id };
        }
        return accumulated;
      }
      case "abstractEq": {
        if (expr.strictStrings) {
          // Both operands are statically strings: use the case-sensitive
          // helper (gate + length + ASCII-case costume probe) via a warp
          // procedure. The call is a statement, queued for the enclosing
          // emitStatements; here we return a reporter reading the result.
          const left = emitValue(expr.l, owner, scope, span);
          const right = emitValue(expr.r, owner, scope, span);
          return emitStringEqInline(
            builder, stringEqPreludeStack[stringEqPreludeStack.length - 1] ?? [], left, right, expr.negate,
          );
        }
        // Native Scratch has no JS ToNumber/strict-string primitive: Cast.compare
        // is case-insensitive and coerces numeric-looking strings. This is the
        // closest native approximation; TSCR2003 keeps the limitation visible.
        const equals = builder.add("operator_equals", { scope, parent: owner, span });
        builder.input(equals, "OPERAND1", emitValue(expr.l, equals, scope, span));
        builder.input(equals, "OPERAND2", emitValue(expr.r, equals, scope, span));
        if (!expr.negate) return { block: equals };
        const not = builder.add("operator_not", { scope, parent: owner, span });
        builder.input(not, "OPERAND", { block: equals });
        return { block: not };
      }
      case "binary": {
        let comparison = expr.op;
        let negate = false;
        if (expr.op === "le") { comparison = "gt"; negate = true; }
        if (expr.op === "ge") { comparison = "lt"; negate = true; }
        if (expr.op === "ne") { comparison = "eq"; negate = true; }
        const opcode = BINARY_OPCODES[comparison];
        if (!opcode) {
          bag.error(CODES.NATIVE_LOWERING, `no native block for binary operation ${expr.op}`, span);
          return { primitive: [4, "0"] };
        }
        const first = BOOLEAN_OPS.has(comparison) ? "OPERAND1" : "NUM1";
        const second = BOOLEAN_OPS.has(comparison) ? "OPERAND2" : "NUM2";
        const id = builder.add(opcode, { scope, parent: owner, span });
        builder.input(id, first, emitValue(expr.l, id, scope, span));
        builder.input(id, second, emitValue(expr.r, id, scope, span));
        if (!negate) return { block: id };
        const notId = builder.add("operator_not", { scope, parent: owner, span });
        builder.input(notId, "OPERAND", { block: id });
        return { block: notId };
      }
      case "convert": {
        const opcode = expr.to === "number" ? "operator_add" : "operator_equals";
        const id = builder.add(opcode, { scope, parent: owner, span });
        const inner = emitValue(expr.value, id, scope, span);
        if (expr.to === "number") {
          builder.input(id, "NUM1", { primitive: [4, "0"] });
          builder.input(id, "NUM2", inner);
        } else {
          builder.input(id, "OPERAND1", inner);
          builder.input(id, "OPERAND2", { primitive: [4, "1"] });
        }
        return { block: id };
      }
      case "listRead": {
        const opcode = expr.op === "length" ? "data_lengthoflist" : "data_itemoflist";
        const id = builder.add(opcode, {
          scope, parent: owner, span,
          fields: listField(builder.listName(expr.list), expr.list),
        });
        if (expr.op === "item" && expr.index) {
          builder.input(id, "INDEX", emitValue(oneBased(expr.index), id, scope, span));
        }
        return { block: id };
      }
      case "intrinsic": {
        const spec = getIntrinsic(expr.name);
        const extensionOpcode = options.extensionOpcodes?.get(expr.name);
        if (spec?.backend === "extension" && extensionOpcode) {
          const id = builder.add(extensionOpcode, { scope, parent: owner, span });
          const names = options.extensionInputs?.get(expr.name) ?? [];
          for (let index = 0; index < names.length; index++) {
            const argument = expr.args[index];
            if (!argument) {
              bag.error(CODES.NATIVE_LOWERING, `extension intrinsic ${expr.name} is missing argument ${index}`, span);
              continue;
            }
            builder.input(id, names[index]!, emitValue(argument, id, scope, span));
          }
          return { block: id };
        }
        if (!spec || spec.backend === "extension" || !spec.opcode) {
          bag.error(CODES.NATIVE_LOWERING, `intrinsic ${expr.name} has no native lowering`, span);
          return { primitive: [4, "0"] };
        }
        const fields = spec.mathOperator
          ? { OPERATOR: [spec.mathOperator, null] as [string, string | null] }
          : undefined;
        const id = builder.add(spec.opcode, { scope, parent: owner, span, fields });
        const names = spec.inputs ?? [];
        for (let index = 0; index < names.length; index++) {
          const argument = expr.args[index];
          if (!argument) {
            bag.error(CODES.NATIVE_LOWERING, `intrinsic ${expr.name} is missing argument ${index}`, span);
            continue;
          }
          builder.input(id, names[index]!, emitValue(argument, id, scope, span));
        }
        return { block: id };
      }
      case "objectNew":
      case "arrayNew":
      case "methodCall":
        bag.error(CODES.NATIVE_LOWERING, `${expr.k} must be lifted by ir-opt before native emission`, span);
        return { primitive: [4, "0"] };
      case "fieldRead": {
        if (!heapLayout?.fields[expr.field]) {
          bag.error(CODES.NATIVE_LOWERING, `no heap list for field ${expr.field}`, span);
          return { primitive: [4, "0"] };
        }
        return {
          block: emitHeapFieldRead(
            builder, scope, heapLayout,
            emitValue(expr.object, owner, scope, span), expr.field,
          ),
        };
      }
      case "arrayRead": {
        if (!heapLayout) {
          bag.error(CODES.NATIVE_LOWERING, "array read without a heap layout", span);
          return { primitive: [4, "0"] };
        }
        const array = emitValue(expr.array, owner, scope, span);
        const index = emitValue(expr.index, owner, scope, span);
        return { block: emitHeapArrayRead(builder, scope, heapLayout, array, index) };
      }
      case "arrayLength": {
        if (!heapLayout) {
          bag.error(CODES.NATIVE_LOWERING, "array length without a heap layout", span);
          return { primitive: [4, "0"] };
        }
        return {
          block: emitHeapArrayLength(
            builder, scope, heapLayout,
            emitValue(expr.array, owner, scope, span),
          ),
        };
      }
      case "call":
        bag.error(CODES.NATIVE_LOWERING, `call to ${expr.function} was not lifted by ir-opt`, span);
        return { primitive: [4, "0"] };
    }
  };

  const frameKey = (
    scope: string, span: SourceSpan | undefined, callerCallId: VarId,
  ): InputRef => frameStore.keyOf(
    builder, scope, span,
    (owner) => emitValue({ k: "read", var: callerCallId, type: "number", span }, owner, scope, span),
  );

  const callToken = (
    scope: string,
    span: SourceSpan | undefined,
    callerCallId: VarId | undefined,
    fallback: VarDecl,
  ): InputRef => {
    if (!callerCallId || !layout) return { obscuredPrimitive: [12, fallback.name, fallback.id] };
    return {
      block: frameStore.readSlot(
        builder, scope, layout, "abi.frame.callToken",
        frameKey(scope, span, callerCallId), span,
      ),
    };
  };

  const emitStatements = (stmts: Stmt[], scope: string, callerCallId?: VarId): string[] => {
    const ids: string[] = [];
    const layer: BlockId[] = [];
    stringEqPreludeStack.push(layer);
    const store = (value: Expr, decl: VarDecl, span?: SourceSpan): void => {
      if (value.type === "boolean") {
        bag.error(
          CODES.VARIABLE_TYPE,
          `boolean expression cannot be written to Scratch variable ${decl.name}`,
          span,
          ["Lower booleans to 0/1 with a convert expression before storing them."],
        );
        return;
      }
      const id = builder.add("data_setvariableto", {
        scope, span, fields: { VARIABLE: [decl.name, decl.id] },
      });
      builder.input(id, "VALUE", emitValue(value, id, scope, span));
      ids.push(id);
    };
    for (const stmt of stmts) {
      const span = stmt.span;
      const idsStart = ids.length;
      layer.length = 0;
      switch (stmt.k) {
        case "declare": {
          if (!stmt.init) continue;
          const decl = variables.get(stmt.var);
          if (!decl) {
            bag.error(CODES.NATIVE_LOWERING, `cannot declare unknown variable ${stmt.var}`, span);
            continue;
          }
          store(stmt.init, decl, span);
          break;
        }
        case "assign": {
          const decl = variables.get(stmt.var);
          const state = frameStateVars.get(stmt.var);
          const listRef = state ? layout?.lists[state.list] : undefined;
          if (state && listRef) {
            const write = builder.add("data_replaceitemoflist", {
              scope, span, fields: { LIST: [listRef.name, listRef.id] },
            });
            const index = builder.add("operator_add", { scope, parent: write, span });
            builder.input(index, "NUM1", emitValue(
              { k: "read", var: state.callId, type: "number", span }, index, scope, span,
            ));
            builder.input(index, "NUM2", { primitive: [4, "1"] });
            builder.input(write, "INDEX", { block: index });
            builder.input(write, "ITEM", emitValue(stmt.value, write, scope, span));
            ids.push(write);
            break;
          }
          if (!decl) {
            bag.error(CODES.NATIVE_LOWERING, `cannot assign unknown variable ${stmt.var}`, span);
            continue;
          }
          store(stmt.value, decl, span);
          break;
        }
        case "expr": {
          const spec = getIntrinsic(stmt.name);
          if (!spec || spec.kind !== "command" || !spec.opcode) {
            bag.error(CODES.NATIVE_LOWERING, `unknown command intrinsic ${stmt.name}`, span);
            continue;
          }
          const id = builder.add(spec.opcode, { scope, span });
          const names = spec.inputs ?? [];
          for (let index = 0; index < names.length; index++) {
            const argument = stmt.args[index];
            if (!argument) {
              bag.error(CODES.NATIVE_LOWERING, `command ${stmt.name} is missing argument ${index}`, span);
              continue;
            }
            builder.input(id, names[index]!, emitValue(argument, id, scope, span));
          }
          ids.push(id);
          break;
        }
        case "list": {
          const id = builder.add(LIST_OPCODES[stmt.op], {
            scope, span,
            fields: listField(builder.listName(stmt.list), stmt.list),
          });
          const args = stmt.args;
          const value = (name: string, expr: Expr): void => {
            builder.input(id, name, emitValue(expr, id, scope, span));
          };
          if (stmt.op === "push" && args[0]) value("ITEM", args[0]);
          if (stmt.op === "insert" && args[0] && args[1]) {
            value("ITEM", args[1]);
            value("INDEX", oneBased(args[0]));
          }
          if (stmt.op === "replace" && args[0] && args[1]) {
            value("INDEX", oneBased(args[0]));
            value("ITEM", args[1]);
          }
          if (stmt.op === "deleteAt" && args[0]) value("INDEX", oneBased(args[0]));
          ids.push(id);
          break;
        }
        case "invoke": {
          const info = procedureInfo.get(stmt.function);
          const callDecl = variables.get(stmt.callId);
          const resultDecl = variables.get(stmt.result);
          if (!layout || !info || !callDecl || !resultDecl) {
            bag.error(CODES.NATIVE_LOWERING, `cannot lower call to ${stmt.function}`, span);
            break;
          }
          const token = { id: callDecl.id, name: callDecl.name };
          ids.push(...frameStore.allocate(builder, scope, layout, token));
          ids.push(...frameStore.appendSlots(builder, scope, layout, token));
          if (callerCallId) {
            ids.push(frameStore.writeSlot(
              builder, scope, layout, "abi.frame.callToken",
              frameKey(scope, span, callerCallId),
              { obscuredPrimitive: [12, callDecl.name, callDecl.id] },
            ));
          }
          const call = builder.add("procedures_call", {
            scope, span,
            mutation: {
              tagName: "mutation",
              proccode: info.proccode,
              argumentids: JSON.stringify(info.argIds),
              children: [],
            },
          });
          for (let index = 0; index < stmt.args.length; index++) {
            const argument = stmt.args[index];
            if (!argument) continue;
            builder.input(call, info.argIds[index]!, emitValue(argument, call, scope, span));
          }
          builder.input(call, info.callIdArg, {
            obscuredPrimitive: [12, callDecl.name, callDecl.id],
          });
          ids.push(call);
          const readBlock = frameStore.readReturnAt(
            builder, scope, layout, callToken(scope, span, callerCallId, callDecl),
          );
          const set = builder.add("data_setvariableto", {
            scope, span, fields: { VARIABLE: [resultDecl.name, resultDecl.id] },
          });
          builder.input(set, "VALUE", { block: readBlock });
          ids.push(set);

          const tagItem = frameStore.readTagAt(
            builder, scope, layout,
            () => callToken(scope, span, callerCallId, callDecl), span,
          );
          const tagDecl = variables.get(stmt.resultTag);
          if (tagDecl) {
            const setTag = builder.add("data_setvariableto", {
              scope, span, fields: { VARIABLE: [tagDecl.name, tagDecl.id] },
            });
            builder.input(setTag, "VALUE", { block: tagItem });
            ids.push(setTag);
          }
          break;
        }
        case "frameReturn": {
          if (!layout) break;
          const callId = (owner: string) => emitValue(
            { k: "read", var: stmt.callId, type: "number" }, owner, scope, span,
          );
          ids.push(frameStore.writeReturn(
            builder, scope, layout, callId,
            (owner) => emitValue(stmt.value, owner, scope, span), span,
          ));
          ids.push(frameStore.writeTag(builder, scope, layout, callId, stmt.tag, span));
          ids.push(...frameStore.complete(builder, scope, layout, callId, callId, span));
          break;
        }
        case "heapAllocate": {
          const tokenDecl = variables.get(stmt.result);
          if (!heapLayout || !tokenDecl) {
            bag.error(CODES.NATIVE_LOWERING, `cannot allocate object of ${stmt.classId}`, span);
            break;
          }
          const fieldValues: Record<string, InputRef> = {};
          for (const field of classById.get(stmt.classId)?.fields ?? []) {
            fieldValues[field.name] = {
              primitive: [10, String(field.initial ?? (field.type === "string" ? "" : 0))],
            };
          }
          ids.push(...emitHeapAllocate(
            builder, scope, heapLayout,
            { id: tokenDecl.id, name: tokenDecl.name },
            stmt.classId,
            fieldValues,
          ));
          break;
        }
        case "heapArrayAllocate": {
          const tokenDecl = variables.get(stmt.result);
          const size = stmt.size;
          if (!heapLayout || !tokenDecl || size.k !== "const" || typeof size.value !== "number"
            || !Number.isSafeInteger(size.value) || size.value < 0 || size.value > 200000) {
            bag.error(
              CODES.NATIVE_LOWERING,
              "array size must be a non-negative compile-time integer",
              span,
            );
            break;
          }
          const defaults: Record<string, InputRef> = {};
          for (const cls of classById.values()) {
            for (const field of cls.fields) {
              defaults[field.name] = { primitive: [10, field.type === "string" ? "" : "0"] };
            }
          }
          ids.push(...emitHeapArrayAllocate(
            builder, scope, heapLayout,
            { id: tokenDecl.id, name: tokenDecl.name },
            size.value,
            defaults,
          ));
          break;
        }
        case "heapFree": {
          if (!heapLayout) {
            bag.error(CODES.NATIVE_LOWERING, "free() without a heap layout", span);
            break;
          }
          ids.push(...emitHeapRelease(
            builder, scope, heapLayout,
            emitValue(stmt.object, "", scope, span),
            stmt.arraySize,
          ));
          break;
        }
        case "fieldWrite": {
          const field = heapLayout?.fields[stmt.field];
          if (!heapLayout || !field) {
            bag.error(CODES.NATIVE_LOWERING, `no heap list for field ${stmt.field}`, span);
            break;
          }
          const write = builder.add("data_replaceitemoflist", {
            scope, span, fields: { LIST: [field.name, field.id] },
          });
          const object = emitValue(stmt.object, write, scope, span);
          const value = emitValue(stmt.value, write, scope, span);
          const indexAdd = builder.add("operator_add", { scope, parent: write, span });
          builder.input(indexAdd, "NUM1", object);
          builder.input(indexAdd, "NUM2", { primitive: [4, "1"] });
          builder.input(write, "INDEX", { block: indexAdd });
          builder.input(write, "ITEM", value);
          ids.push(write);
          break;
        }
        case "arrayWrite": {
          if (!heapLayout) {
            bag.error(CODES.NATIVE_LOWERING, "array write without a heap layout", span);
            break;
          }
          const write = builder.add("data_replaceitemoflist", {
            scope, span,
            fields: { LIST: [heapLayout.arrayItems.name, heapLayout.arrayItems.id] },
          });
          const array = emitValue(stmt.array, write, scope, span);
          const index = emitValue(stmt.index, write, scope, span);
          const value = emitValue(stmt.value, write, scope, span);
          const start = builder.add("data_itemoflist", {
            scope,
            fields: { LIST: [heapLayout.arrayStart.name, heapLayout.arrayStart.id] },
          });
          const startIndex = builder.add("operator_add", { scope, parent: start, span });
          builder.input(startIndex, "NUM1", array);
          builder.input(startIndex, "NUM2", { primitive: [4, "1"] });
          builder.input(start, "INDEX", { block: startIndex });
          const offset = builder.add("operator_add", { scope, parent: write, span });
          builder.input(offset, "NUM1", { block: start });
          builder.input(offset, "NUM2", index);
          const position = builder.add("operator_add", { scope, parent: write, span });
          builder.input(position, "NUM1", { block: offset });
          builder.input(position, "NUM2", { primitive: [4, "1"] });
          builder.input(write, "INDEX", { block: position });
          builder.input(write, "ITEM", value);
          ids.push(write);
          break;
        }
        case "virtualInvoke": {
          const callDecl = variables.get(stmt.callId);
          const resultDecl = variables.get(stmt.result);
          if (!heapLayout || !layout || !callDecl || !resultDecl) {
            bag.error(CODES.NATIVE_LOWERING, `cannot lower virtual call ${stmt.method}`, span);
            break;
          }
          const token = { id: callDecl.id, name: callDecl.name };
          ids.push(...frameStore.allocate(builder, scope, layout, token));
          ids.push(...frameStore.appendSlots(builder, scope, layout, token));
          if (callerCallId) {
            ids.push(frameStore.writeSlot(
              builder, scope, layout, "abi.frame.callToken",
              frameKey(scope, span, callerCallId),
              { obscuredPrimitive: [12, callDecl.name, callDecl.id] },
            ));
          }
          for (const target of stmt.targets) {
            const info = procedureInfo.get(target.function);
            if (!info) {
              bag.error(CODES.NATIVE_LOWERING, `no procedure for ${target.function}`, span);
              continue;
            }
            const equals = builder.add("operator_equals", { scope, span });
            const classItem = emitHeapClassOf(
              builder, scope, heapLayout,
              emitValue(stmt.object, equals, scope, span),
            );
            builder.input(equals, "OPERAND1", { block: classItem });
            builder.input(equals, "OPERAND2", { primitive: [10, target.classId] });
            const branch = builder.add("control_if", { scope, span });
            builder.input(branch, "CONDITION", { block: equals });
            const call = builder.add("procedures_call", {
              scope, span,
              mutation: {
                tagName: "mutation",
                proccode: info.proccode,
                argumentids: JSON.stringify(info.argIds),
                children: [],
              },
            });
            builder.input(call, info.argIds[0]!, emitValue(stmt.object, call, scope, span));
            for (let index = 0; index < stmt.args.length; index++) {
              const argument = stmt.args[index];
              if (!argument) continue;
              builder.input(call, info.argIds[index + 1]!, emitValue(argument, call, scope, span));
            }
            builder.input(call, info.callIdArg, {
              obscuredPrimitive: [12, callDecl.name, callDecl.id],
            });
            builder.substack(branch, "SUBSTACK", call);
            ids.push(branch);
          }
          const readBlock = frameStore.readReturnAt(
            builder, scope, layout, callToken(scope, span, callerCallId, callDecl),
          );
          const set = builder.add("data_setvariableto", {
            scope, span, fields: { VARIABLE: [resultDecl.name, resultDecl.id] },
          });
          builder.input(set, "VALUE", { block: readBlock });
          ids.push(set);
          const tagItem = frameStore.readTagAt(
            builder, scope, layout,
            () => callToken(scope, span, callerCallId, callDecl), span,
          );
          const tagDecl = variables.get(stmt.resultTag);
          if (tagDecl) {
            const setTag = builder.add("data_setvariableto", {
              scope, span, fields: { VARIABLE: [tagDecl.name, tagDecl.id] },
            });
            builder.input(setTag, "VALUE", { block: tagItem });
            ids.push(setTag);
          }
          break;
        }
        case "return":
          bag.error(CODES.NATIVE_LOWERING, "return must be rewritten by ir-opt before native emission", span);
          break;
        case "break":
        case "continue":
          bag.error(
            CODES.NATIVE_LOWERING,
            `${stmt.k} must be rewritten by ir-opt before native emission`,
            span,
          );
          break;
        case "tryCall":
          bag.error(
            CODES.NATIVE_LOWERING,
            "try/catch has no native Scratch primitive; run this project with the IR interpreter",
            span,
            ["tryCall is preserved in IR and executed correctly by interpretModules."],
          );
          break;
        case "raise":
          bag.error(
            CODES.NATIVE_LOWERING,
            "throw has no native Scratch primitive; run this project with the IR interpreter",
            span,
          );
          break;
        case "if": {
          const id = builder.add(stmt.else ? "control_if_else" : "control_if", { scope, span });
          builder.input(id, "CONDITION", emitValue(stmt.cond, id, scope, span));
          const thenIds = emitStatements(stmt.then, `${scope}/then`, callerCallId);
          if (thenIds.length > 0) {
            builder.chain(thenIds);
            builder.substack(id, "SUBSTACK", thenIds[0]);
          }
          if (stmt.else) {
            const elseIds = emitStatements(stmt.else, `${scope}/else`, callerCallId);
            if (elseIds.length > 0) {
              builder.chain(elseIds);
              builder.substack(id, "SUBSTACK2", elseIds[0]);
            }
          }
          ids.push(id);
          break;
        }
        case "while": {
          const id = builder.add("control_repeat_until", { scope, span });
          const notId = builder.add("operator_not", { scope, parent: id, span });
          builder.input(notId, "OPERAND", emitValue(stmt.cond, notId, scope, span));
          builder.input(id, "CONDITION", { block: notId });
          const bodyIds = emitStatements(stmt.body, `${scope}/body`, callerCallId);
          if (bodyIds.length > 0) {
            builder.chain(bodyIds);
            builder.substack(id, "SUBSTACK", bodyIds[0]);
          }
          ids.push(id);
          break;
        }
        case "sequence": {
          ids.push(...emitStatements(stmt.body, scope, callerCallId));
          break;
        }
      }
      // Strict-string calls are statements that must run immediately before
      // the statement whose expression reads their result — not before the
      // whole block (earlier statements may initialize the operands).
      if (layer.length > 0) ids.splice(idsStart, 0, ...layer);
    }
    stringEqPreludeStack.pop();
    return ids;
  };

  for (const module of modules) {
    const roleName = module.role?.name ?? "Sprite1";
    builder.setActiveTarget(roleName);
    module.scripts.forEach((script, index) => {
      const scope = `${roleName}:${index}`;
      const hat = builder.add(HAT_OPCODES[script.hat.kind], {
        scope, topLevel: true, x: 40, y: 40 + index * 320, span: script.span,
        fields: hatFields(script.hat, (name) => builder.declareBroadcast(name)),
      });
      if (script.hat.kind === "greaterThan") {
        const menu = builder.addShadow("event_whengreaterthanmenu", hat, {
          WHENGREATERTHANMENU: [script.hat.sensor, null],
        }, scope);
        builder.input(hat, "WHENGREATERTHANMENU", { shadowBlock: menu });
        builder.input(hat, "VALUE", { primitive: [4, String(script.hat.value)] });
      }
      const ids = emitStatements(script.body, scope);
      builder.chain([hat, ...ids]);
    });
    for (const [index, fn] of (module.functions ?? []).entries()) {
      const info = procedureInfo.get(fn.id)!;
      const scope = `fn:${fn.id}`;
      const definition = builder.add("procedures_definition", {
        scope, topLevel: true, x: 600, y: 40 + index * 320, span: fn.span,
      });
      const prototype = builder.add("procedures_prototype", {
        scope, parent: definition, shadow: true,
        mutation: {
          tagName: "mutation",
          proccode: info.proccode,
          argumentnames: JSON.stringify(info.argNames),
          argumentids: JSON.stringify(info.argIds),
          argumentdefaults: JSON.stringify(info.defaults),
          warp: info.warp ? "true" : "false",
          children: [],
        },
      });
      builder.input(definition, "custom_block", { shadowBlock: prototype });
      const bodyIds = emitStatements(fn.body, scope, fn.callId);
      builder.chain([definition, ...bodyIds]);
    }
  }

  return { graph: builder.project, builder };
}
