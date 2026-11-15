import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import {
  GraphBuilder,
  type Field,
  type InputRef,
  type Primitive,
  type ProjectGraph,
  type RoleDecl,
} from "@typescratch/graph";
import type { BinOp, Expr, FunctionDecl, FunctionId, Hat, ListOp, Module, Stmt, VarDecl, VarId } from "@typescratch/ir";
import { getIntrinsic } from "@typescratch/language";
import {
  declareFrameLayout,
  emitFrameAllocate,
  emitFrameReturnRead,
  emitFrameSlotAppend,
  type FrameLayout,
} from "./frame-blocks.ts";

const HAT_OPCODES: Record<Hat["kind"], string> = {
  flag: "event_whenflagclicked",
  key: "event_whenkeypressed",
  spriteClicked: "event_whenthisspriteclicked",
  clone: "control_start_as_clone",
  backdrop: "event_whenbackdropswitchesto",
  broadcast: "event_whenbroadcastreceived",
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

export function lowerNative(
  input: Module | Module[],
  bag: DiagnosticBag,
  options: NativeLoweringOptions = {},
): NativeLoweringResult {
  const modules = Array.isArray(input) ? input : [input];
  const builder = new GraphBuilder(options.roles ?? []);
  const variables = new Map(modules.flatMap((module) => module.vars).map((decl) => [decl.id, decl]));
  const functions = new Map<FunctionId, FunctionDecl>();
  const procedureInfo = new Map<FunctionId, ProcedureInfo>();
  const paramNames = new Map<VarId, { name: string; boolean: boolean }>();

  for (const module of modules) {
    for (const fn of module.functions ?? []) {
      functions.set(fn.id, fn);
      const argIds = [...fn.params.map((_, index) => `input${index}`), "inputCallId"];
      const callIdName = variables.get(fn.callId)?.name ?? "callId";
      const argNames = [...fn.params.map((param) => param.name), callIdName];
      procedureInfo.set(fn.id, {
        proccode: `${fn.name} ${argIds.map(() => "%s").join(" ")}`,
        argIds,
        argNames,
        defaults: argIds.map(() => ""),
        callIdArg: "inputCallId",
      });
      for (const param of fn.params) {
        paramNames.set(param.id, { name: param.name, boolean: param.type === "boolean" });
      }
      paramNames.set(fn.callId, { name: callIdName, boolean: false });
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
  const layout: FrameLayout | undefined = functions.size > 0
    ? declareFrameLayout(builder)
    : undefined;

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
      case "call":
        bag.error(CODES.NATIVE_LOWERING, `call to ${expr.function} was not lifted by ir-opt`, span);
        return { primitive: [4, "0"] };
    }
  };

  const emitStatements = (stmts: Stmt[], scope: string): string[] => {
    const ids: string[] = [];
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
          ids.push(...emitFrameAllocate(builder, scope, layout, token));
          ids.push(...emitFrameSlotAppend(builder, scope, layout, token));
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
          const readBlock = emitFrameReturnRead(builder, scope, layout, token);
          const set = builder.add("data_setvariableto", {
            scope, span, fields: { VARIABLE: [resultDecl.name, resultDecl.id] },
          });
          builder.input(set, "VALUE", { block: readBlock });
          ids.push(set);

          const tagList = layout.lists["abi.frame.returnTag"]!;
          const tagItem = builder.add("data_itemoflist", {
            scope, fields: listField(tagList.name, tagList.id),
          });
          const tagIndex = builder.add("operator_add", { scope, parent: tagItem, span });
          builder.input(tagIndex, "NUM1", { obscuredPrimitive: [12, callDecl.name, callDecl.id] });
          builder.input(tagIndex, "NUM2", { primitive: [4, "1"] });
          builder.input(tagItem, "INDEX", { block: tagIndex });
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
          const list = layout.lists["abi.frame.returnValue"]!;
          const replace = builder.add("data_replaceitemoflist", {
            scope, span, fields: listField(list.name, list.id),
          });
          const indexAdd = builder.add("operator_add", { scope, parent: replace, span });
          builder.input(indexAdd, "NUM1", emitValue(
            { k: "read", var: stmt.callId, type: "number" }, indexAdd, scope, span,
          ));
          builder.input(indexAdd, "NUM2", { primitive: [4, "1"] });
          builder.input(replace, "INDEX", { block: indexAdd });
          builder.input(replace, "ITEM", emitValue(stmt.value, replace, scope, span));
          ids.push(replace);

          const tagList = layout.lists["abi.frame.returnTag"]!;
          const tagReplace = builder.add("data_replaceitemoflist", {
            scope, span, fields: listField(tagList.name, tagList.id),
          });
          const tagIndex = builder.add("operator_add", { scope, parent: tagReplace, span });
          builder.input(tagIndex, "NUM1", emitValue(
            { k: "read", var: stmt.callId, type: "number" }, tagIndex, scope, span,
          ));
          builder.input(tagIndex, "NUM2", { primitive: [4, "1"] });
          builder.input(tagReplace, "INDEX", { block: tagIndex });
          builder.input(tagReplace, "ITEM", { primitive: [10, stmt.tag] });
          ids.push(tagReplace);

          const statusList = layout.lists["abi.frame.status"]!;
          const statusReplace = builder.add("data_replaceitemoflist", {
            scope, span, fields: listField(statusList.name, statusList.id),
          });
          const statusIndex = builder.add("operator_add", { scope, parent: statusReplace, span });
          builder.input(statusIndex, "NUM1", emitValue(
            { k: "read", var: stmt.callId, type: "number" }, statusIndex, scope, span,
          ));
          builder.input(statusIndex, "NUM2", { primitive: [4, "1"] });
          builder.input(statusReplace, "INDEX", { block: statusIndex });
          builder.input(statusReplace, "ITEM", { primitive: [10, "completed"] });
          const free = builder.add("data_addtolist", {
            scope, span, fields: listField(layout.freeFrames.name, layout.freeFrames.id),
          });
          builder.input(free, "ITEM", emitValue(
            { k: "read", var: stmt.callId, type: "number" }, free, scope, span,
          ));
          ids.push(statusReplace, free);
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
        case "if": {
          const id = builder.add(stmt.else ? "control_if_else" : "control_if", { scope, span });
          builder.input(id, "CONDITION", emitValue(stmt.cond, id, scope, span));
          const thenIds = emitStatements(stmt.then, `${scope}/then`);
          if (thenIds.length > 0) {
            builder.chain(thenIds);
            builder.substack(id, "SUBSTACK", thenIds[0]);
          }
          if (stmt.else) {
            const elseIds = emitStatements(stmt.else, `${scope}/else`);
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
          const bodyIds = emitStatements(stmt.body, `${scope}/body`);
          if (bodyIds.length > 0) {
            builder.chain(bodyIds);
            builder.substack(id, "SUBSTACK", bodyIds[0]);
          }
          ids.push(id);
          break;
        }
        case "sequence": {
          ids.push(...emitStatements(stmt.body, scope));
          break;
        }
      }
    }
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
          warp: "false",
          children: [],
        },
      });
      builder.input(definition, "custom_block", { shadowBlock: prototype });
      const bodyIds = emitStatements(fn.body, scope);
      builder.chain([definition, ...bodyIds]);
    }
  }

  return { graph: builder.project, builder };
}
