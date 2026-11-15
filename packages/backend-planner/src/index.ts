import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import { allCommands, allExprs, type Expr, type Module, type Stmt } from "@typescratch/ir";
import { getIntrinsic, type Target } from "@typescratch/language";
import {
  ABI_OPERATION_COSTS,
  EXTENSION_OPS,
  NO_ABI_USAGE,
  extensionIdFor,
  fullOpcode,
  mergeAbiRegions,
  regionSummary,
  requiredContracts,
  unsupportedContracts,
  type AbiContract,
  type AbiOperation,
  type AbiOperationKind,
  type AbiRegionSummary,
  type AbiUsage,
  type ExtensionOpcodeSpec,
} from "@typescratch/runtime-abi";

export interface PlanEntry {
  operation: string;
  decision: "native" | "extension" | "error";
  detail: string;
  span?: SourceSpan;
  regionId?: string;
  cost: number;
  strategy?: "static" | "native" | "extension";
  abiProfile?: "native" | "extension";
  contract?: AbiContract;
}

export interface ExtensionRegion {
  id: string;
  intrinsic: string;
  opcode: string;
  spec: ExtensionOpcodeSpec;
  occurrences: number;
  span?: SourceSpan;
}

export interface BackendPlan {
  entries: PlanEntry[];
  regions: ExtensionRegion[];
  extensionId?: string;
  extensionOpcodes: Map<string, string>;
  extensionInputs: Map<string, string[]>;
  boundaryCalls: number;
  nativeOps: number;
  abiUsage: AbiUsage;
  abiContracts: AbiContract[];
  unsupported: AbiContract[];
  abiRegions: AbiRegionSummary;
}

export interface PlannerOptions {
  maxBoundaryCalls?: number;
  seed?: string;
  /** Configured profile, recorded in PlanEntry. May differ from the actual lowering. */
  abiProfile?: "native" | "extension";
  /** The runtime that actually emits the ABI; capability checks use this, not the declaration. */
  lowering?: "native" | "extension";
}

export interface BackendCapability {
  native: "supported" | "emulated" | "unsupported";
  extension: "supported" | "unsupported";
  cost: "low" | "medium" | "high";
}

export function capabilityFor(intrinsic: string): BackendCapability {
  const native = getIntrinsic(intrinsic);
  const extension = EXTENSION_OPS[intrinsic];
  return {
    native: native?.backend === "native" ? "supported" : "unsupported",
    extension: extension ? "supported" : "unsupported",
    cost: extension ? "medium" : "low",
  };
}

/** §2: which of the six contracts a program actually needs, derived from lowered IR. */
export function collectAbiUsage(modules: readonly Module[]): AbiUsage {
  const usage: AbiUsage = { ...NO_ABI_USAGE };
  const visitStatements = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.k) {
        case "invoke":
        case "frameReturn":
          usage.value = usage.call = usage.frame = true;
          break;
        case "virtualInvoke":
          usage.value = usage.call = usage.frame = usage.dispatch = true;
          break;
        case "heapAllocate":
        case "heapArrayAllocate":
        case "heapFree":
        case "fieldWrite":
        case "arrayWrite":
          usage.memory = true;
          break;
        case "if":
          visitStatements(stmt.then);
          if (stmt.else) visitStatements(stmt.else);
          break;
        case "while":
        case "sequence":
          visitStatements(stmt.body);
          break;
        default:
          break;
      }
    }
  };
  for (const module of modules) {
    for (const script of module.scripts) visitStatements(script.body);
    for (const fn of module.functions ?? []) visitStatements(fn.body);
    for (const expr of allExprs(module)) {
      switch (expr.k) {
        case "call":
          usage.value = usage.call = usage.frame = true;
          break;
        case "methodCall":
          usage.value = usage.call = usage.frame = usage.dispatch = true;
          break;
        case "objectNew":
        case "arrayNew":
        case "fieldRead":
        case "arrayRead":
        case "arrayLength":
          usage.memory = true;
          break;
        case "intrinsic":
          if (getIntrinsic(expr.name)?.effect === "yields") usage.execution = true;
          break;
        default:
          break;
      }
    }
    for (const command of allCommands(module)) {
      if (getIntrinsic(command.name)?.effect === "yields") usage.execution = true;
    }
  }
  return usage;
}

/** §3: every ABI operation in source order, so consecutive ones can share a region. */
export function collectAbiOperations(modules: readonly Module[]): AbiOperation[] {
  const operations: AbiOperation[] = [];
  let sequence = 0;
  const push = (kind: AbiOperationKind, scope: string): void => {
    const spec = ABI_OPERATION_COSTS[kind];
    operations.push({ kind, contract: spec.contract, cost: spec.cost, sequence: sequence++, scope });
  };
  const visitExpr = (expr: Expr, scope: string): void => {
    switch (expr.k) {
      case "objectNew":
      case "arrayNew":
        push("heap.allocate", scope);
        break;
      case "fieldRead":
        visitExpr(expr.object, scope);
        push("heap.field.read", scope);
        break;
      case "arrayLength":
        visitExpr(expr.array, scope);
        push("heap.array.read", scope);
        break;
      case "arrayRead":
        visitExpr(expr.array, scope);
        visitExpr(expr.index, scope);
        push("heap.array.read", scope);
        break;
      case "binary":
        visitExpr(expr.l, scope);
        visitExpr(expr.r, scope);
        break;
      case "unary":
      case "convert":
        visitExpr(expr.value, scope);
        break;
      case "join":
        for (const part of expr.parts) visitExpr(part, scope);
        break;
      case "intrinsic":
      case "call":
      case "methodCall":
        for (const argument of expr.args) visitExpr(argument, scope);
        break;
      case "listRead":
        if (expr.index) visitExpr(expr.index, scope);
        break;
      default:
        break;
    }
  };
  const visitStatements = (stmts: Stmt[], scope: string): void => {
    for (const stmt of stmts) {
      switch (stmt.k) {
        case "invoke":
          for (const argument of stmt.args) visitExpr(argument, scope);
          push("frame.allocate", scope);
          push("value.tag", scope);
          push("call", scope);
          push("value.untag", scope);
          break;
        case "virtualInvoke":
          visitExpr(stmt.object, scope);
          for (const argument of stmt.args) visitExpr(argument, scope);
          push("frame.allocate", scope);
          push("dispatch", scope);
          push("value.untag", scope);
          break;
        case "frameReturn":
          visitExpr(stmt.value, scope);
          push("value.tag", scope);
          push("frame.return", scope);
          break;
        case "heapAllocate":
        case "heapArrayAllocate":
          push("heap.allocate", scope);
          break;
        case "heapFree":
          visitExpr(stmt.object, scope);
          push("heap.free", scope);
          break;
        case "fieldWrite":
          visitExpr(stmt.object, scope);
          visitExpr(stmt.value, scope);
          push("heap.field.write", scope);
          break;
        case "arrayWrite":
          visitExpr(stmt.array, scope);
          visitExpr(stmt.index, scope);
          visitExpr(stmt.value, scope);
          push("heap.array.write", scope);
          break;
        case "declare":
          if (stmt.init) visitExpr(stmt.init, scope);
          break;
        case "assign":
          visitExpr(stmt.value, scope);
          break;
        case "expr":
        case "list":
          for (const argument of stmt.args) visitExpr(argument, scope);
          break;
        case "return":
          if (stmt.value) visitExpr(stmt.value, scope);
          break;
        case "if":
          visitExpr(stmt.cond, scope);
          visitStatements(stmt.then, scope);
          if (stmt.else) visitStatements(stmt.else, scope);
          break;
        case "while":
          visitExpr(stmt.cond, scope);
          visitStatements(stmt.body, scope);
          break;
        case "sequence":
          visitStatements(stmt.body, scope);
          break;
        default:
          break;
      }
    }
  };
  for (const module of modules) {
    const role = module.role?.name ?? "Sprite1";
    module.scripts.forEach((script, index) => visitStatements(script.body, `${role}:${index}`));
    for (const fn of module.functions ?? []) visitStatements(fn.body, `fn:${fn.id}`);
  }
  return operations;
}

export function planBackends(
  modules: Module | Module[],
  target: Target,
  bag: DiagnosticBag,
  options: PlannerOptions = {},
): BackendPlan {
  const list = Array.isArray(modules) ? modules : [modules];
  const abiUsage = collectAbiUsage(list);
  const abiContracts = requiredContracts(abiUsage);
  const abiRegions = regionSummary(mergeAbiRegions(collectAbiOperations(list)));
  const lowering = options.lowering ?? options.abiProfile ?? "native";
  const unsupported = unsupportedContracts(lowering, abiUsage);
  for (const contract of unsupported) {
    bag.error(
      CODES.ABI,
      `ABI contract ${contract} is not supported by the ${lowering} profile`,
      undefined,
      ["Unsupported contracts must fail at plan time, not at runtime with a wrong answer."],
    );
  }
  const entries: PlanEntry[] = [];
  const regions = new Map<string, ExtensionRegion>();
  const extensionIntrinsics: string[] = [];
  let nativeOps = 0;

  const visitCalls = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      if (stmt.k === "invoke") {
        const profile = options.abiProfile ?? "native";
        entries.push({
          operation: `call:${stmt.function}`,
          decision: "native",
          detail: `Frame ABI via procedures_*; configured profile: ${profile}`,
          span: stmt.span,
          cost: 3,
          strategy: "native",
          abiProfile: profile,
          contract: "frame",
        });
      }
      if (stmt.k === "virtualInvoke") {
        const profile = options.abiProfile ?? "native";
        entries.push({
          operation: `dispatch:${stmt.method}`,
          decision: "native",
          detail: `heap.classId type tests -> ${stmt.targets.length} method(s); configured profile: ${profile}`,
          span: stmt.span,
          cost: 3 + stmt.targets.length,
          strategy: "native",
          abiProfile: profile,
          contract: "dispatch",
        });
      }
      if (stmt.k === "if") {
        visitCalls(stmt.then);
        if (stmt.else) visitCalls(stmt.else);
      }
      if (stmt.k === "while" || stmt.k === "sequence") visitCalls(stmt.body);
    }
  };

  for (const module of list) {
    for (const script of module.scripts) visitCalls(script.body);
    for (const fn of module.functions ?? []) visitCalls(fn.body);

    for (const expr of allExprs(module)) {
      if (expr.k !== "intrinsic") continue;
      const spec = getIntrinsic(expr.name);
      if (spec?.backend === "native") {
        nativeOps += 1;
        entries.push({
          operation: expr.name,
          decision: "native",
          detail: spec.opcode ?? "",
          span: expr.span,
          cost: 0,
        });
        continue;
      }
      const extensionSpec = EXTENSION_OPS[expr.name];
      if (!extensionSpec) {
        entries.push({
          operation: expr.name,
          decision: "error",
          detail: "no backend capability",
          span: expr.span,
          cost: 0,
        });
        bag.error(
          CODES.NATIVE_LOWERING,
          `${expr.name} cannot be lowered by either backend`,
          expr.span,
          ["Add an intrinsic to the capability catalog or rewrite the source using supported APIs."],
        );
        continue;
      }
      extensionIntrinsics.push(expr.name);
      if (target === "scratch") {
        entries.push({
          operation: expr.name,
          decision: "error",
          detail: "target=scratch forbids custom extensions",
          span: expr.span,
          cost: 0,
        });
        bag.error(
          CODES.COMPAT,
          `${expr.name} requires a TurboWarp custom extension`,
          expr.span,
          [
            "Selected target: scratch",
            "Required target: TurboWarp",
            "Compatibility: official Scratch = unsupported",
            "Rebuild with --target turbowarp or use a native equivalent.",
          ],
        );
        continue;
      }
      const existing = regions.get(expr.name);
      const region: ExtensionRegion = existing ?? {
        id: `region:${expr.name}`,
        intrinsic: expr.name,
        opcode: extensionSpec.opcode,
        spec: extensionSpec,
        occurrences: 0,
        span: expr.span,
      };
      region.occurrences += 1;
      regions.set(expr.name, region);
      entries.push({
        operation: expr.name,
        decision: "extension",
        detail: `${extensionSpec.opcode} (${extensionSpec.arguments.length} ABI args)`,
        span: expr.span,
        regionId: region.id,
        cost: 2,
      });
    }

    for (const command of allCommands(module)) {
      const spec = getIntrinsic(command.name);
      if (!spec || spec.kind !== "command") {
        entries.push({
          operation: command.name,
          decision: "error",
          detail: "unknown command intrinsic",
          span: command.span,
          cost: 0,
        });
        bag.error(CODES.NATIVE_LOWERING, `unknown command intrinsic ${command.name}`, command.span);
      } else {
        nativeOps += 1;
        entries.push({
          operation: command.name,
          decision: "native",
          detail: spec.opcode ?? "",
          span: command.span,
          cost: 0,
        });
      }
    }
  }

  const regionList = [...regions.values()].sort((left, right) =>
    left.intrinsic.localeCompare(right.intrinsic),
  );
  const extensionId = regionList.length > 0
    ? extensionIdFor(options.seed ?? list[0]?.entry ?? "project", extensionIntrinsics)
    : undefined;
  const extensionOpcodes = new Map(
    regionList.map((region) => [region.intrinsic, fullOpcode(extensionId!, region.spec)]),
  );
  const extensionInputs = new Map(
    regionList.map((region) => [
      region.intrinsic,
      region.spec.arguments.map((argument) => argument.name),
    ]),
  );
  const boundaryCalls = regionList.reduce((total, region) => total + region.occurrences, 0);

  if (regionList.length > 0) {
    bag.warning(
      CODES.COMPAT,
      "This project contains TurboWarp custom extension blocks",
      undefined,
      [
        "The extension JS is embedded in project.json.extensionURLs as a data: URL; TurboWarp loads it automatically.",
        "Custom extension projects cannot be uploaded to the official Scratch website.",
        "Sandboxed extension calls cost at least one VM frame each.",
      ],
    );
  }
  const limit = options.maxBoundaryCalls ?? 8;
  if (boundaryCalls > limit) {
    bag.warning(
      CODES.PERF,
      `${boundaryCalls} Native/Extension boundary calls exceed the threshold of ${limit}`,
      undefined,
      ["Group dense extension computation into fewer regions to reduce scheduling overhead."],
    );
  }

  return {
    entries,
    regions: regionList,
    extensionId,
    extensionOpcodes,
    extensionInputs,
    boundaryCalls,
    nativeOps,
    abiUsage,
    abiContracts,
    unsupported,
    abiRegions,
  };
}
