import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import {
  GraphBuilder,
  type InputRef,
  type Primitive,
  type ProjectGraph,
  type RoleDecl,
} from "@typescratch/graph";
import type { BinOp, Expr, Module, Stmt, VarDecl } from "@typescratch/ir";
import { getIntrinsic } from "@typescratch/language";

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

function initialValue(decl: VarDecl): string | number | boolean {
  if (decl.initial !== undefined) return decl.initial;
  if (decl.type === "string") return "";
  if (decl.type === "boolean") return false;
  return 0;
}

export function lowerNative(
  input: Module | Module[],
  bag: DiagnosticBag,
  options: NativeLoweringOptions = {},
): NativeLoweringResult {
  const modules = Array.isArray(input) ? input : [input];
  const builder = new GraphBuilder(options.roles ?? []);
  const variables = new Map(modules.flatMap((module) => module.vars).map((decl) => [decl.id, decl]));

  for (const module of modules) {
    builder.setActiveTarget(module.role?.name ?? "Sprite1");
    for (const decl of module.vars) {
      builder.declareVariable(decl.id, decl.name, initialValue(decl), decl.storage);
    }
  }

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
    }
  };

  const emitStatements = (stmts: Stmt[], scope: string): string[] => {
    const ids: string[] = [];
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
          const id = builder.add("data_setvariableto", {
            scope, span, fields: { VARIABLE: [decl.name, decl.id] },
          });
          builder.input(id, "VALUE", emitValue(stmt.init, id, scope, span));
          ids.push(id);
          break;
        }
        case "assign": {
          const decl = variables.get(stmt.var);
          if (!decl) {
            bag.error(CODES.NATIVE_LOWERING, `cannot assign unknown variable ${stmt.var}`, span);
            continue;
          }
          const id = builder.add("data_setvariableto", {
            scope, span, fields: { VARIABLE: [decl.name, decl.id] },
          });
          builder.input(id, "VALUE", emitValue(stmt.value, id, scope, span));
          ids.push(id);
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
      const hat = builder.add("event_whenflagclicked", {
        scope, topLevel: true, x: 40, y: 40 + index * 320, span: script.span,
      });
      const ids = emitStatements(script.body, scope);
      builder.chain([hat, ...ids]);
    });
  }

  return { graph: builder.project, builder };
}
