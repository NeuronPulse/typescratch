import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";
import { allCommands, allExprs, type Module, type Stmt } from "@typescratch/ir";
import { getIntrinsic, type Target } from "@typescratch/language";
import {
  EXTENSION_OPS,
  extensionIdFor,
  fullOpcode,
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
}

export interface PlannerOptions {
  maxBoundaryCalls?: number;
  seed?: string;
  abiProfile?: "native" | "extension";
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

export function planBackends(
  modules: Module | Module[],
  target: Target,
  bag: DiagnosticBag,
  options: PlannerOptions = {},
): BackendPlan {
  const list = Array.isArray(modules) ? modules : [modules];
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
  };
}
