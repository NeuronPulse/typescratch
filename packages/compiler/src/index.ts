import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODES,
  DiagnosticBag,
  type Diagnostic,
  type SourceSpan,
} from "@typescratch/diagnostics";
import { createTypedProgram, lowerToHIR, type FrontendConfig } from "@typescratch/frontend-ts";
import { printModule, validateModule, validateYieldBoundaries, type Module } from "@typescratch/ir";
import {
  emptyOptimizationStats,
  lowerControlFlow,
  optimizeModules,
  type OptimizationStats,
} from "@typescratch/ir-opt";
import type { Target } from "@typescratch/language";
import { validateGraph, type ProjectGraph, type RoleDecl } from "@typescratch/graph";
import { lowerNative } from "@typescratch/backend-native";
import { buildProjectJson, exportSb3 } from "@typescratch/exporter-sb3";
import { planBackends, type BackendPlan, type PlanEntry } from "@typescratch/backend-planner";
import { generateExtension, type ExtensionBundle } from "@typescratch/backend-turbowarp";
import { assembleOutputs, type OutputFile } from "@typescratch/exporter-turbowarp";
import { loadWorkspace } from "@typescratch/workspace";
import {
  allowedProfiles,
  isProfileAllowed,
  selectProfile,
  type AbiContract,
  type AbiProfileSelection,
} from "@typescratch/runtime-abi";

export type { PlanEntry } from "@typescratch/backend-planner";
export type { OptimizationStats } from "@typescratch/ir-opt";

export interface NumericProfileReport {
  model: "scratch";
  documentedDifferences: string[];
}

export const NUMERIC_PROFILE: NumericProfileReport = {
  model: "scratch",
  documentedDifferences: [
    "operator_equals compares numerically and case-insensitively, not with JavaScript ===",
    "operator_mod returns a divisor-signed remainder, unlike the JavaScript % operator",
    "Cast.toNumber maps NaN to 0 and accepts numeric strings",
    "Infinity and NaN are rejected by the frontend as unstable Scratch variable values",
  ],
};

export interface CompileOptions {
  entry?: string;
  projectRoot: string;
  target?: Target;
  configPath?: string;
  explain?: boolean;
  runtimeDts?: string;
  outputName?: string;
  maxBoundaryCalls?: number;
  optimize?: boolean;
  abiProfile?: string;
}

export interface BuildReport {
  target: Target;
  entry: string;
  ok: boolean;
  abiProfile: AbiProfileSelection;
  abiContracts: {
    required: AbiContract[];
    unsupported: AbiContract[];
  };
  diagnostics: Diagnostic[];
  plan: PlanEntry[];
  compatibility: {
    officialScratch: boolean;
    turboWarp: boolean;
    customExtensions: number;
    notes: string[];
  };
  numericProfile: NumericProfileReport;
  optimization: OptimizationStats;
  sourceMap: { blockId: string; span: SourceSpan }[];
  blockCount: number;
  boundaryCalls: number;
  extensionId?: string;
  outputs: string[];
  hirDump?: string;
  projectJson?: string;
}

export interface CompileResult {
  ok: boolean;
  report: BuildReport;
  sb3?: Uint8Array;
  outputs: OutputFile[];
  modules: Module[];
  graph?: ProjectGraph;
  bundle?: ExtensionBundle;
  plan?: BackendPlan;
}

function failure(
  target: Target,
  entry: string,
  bag: DiagnosticBag,
  abiProfile: AbiProfileSelection,
  entries: PlanEntry[],
  modules: Module[] = [],
  graph?: ProjectGraph,
): CompileResult {
  const report: BuildReport = {
    target,
    entry,
    ok: false,
    abiProfile,
    abiContracts: { required: [], unsupported: [] },
    diagnostics: bag.items,
    plan: entries,
    compatibility: {
      officialScratch: false,
      turboWarp: false,
      customExtensions: 0,
      notes: [],
    },
    numericProfile: NUMERIC_PROFILE,
    optimization: emptyOptimizationStats(),
    sourceMap: [],
    blockCount: 0,
    boundaryCalls: 0,
    outputs: [],
    hirDump: modules.length > 0 ? JSON.stringify(modules.map(printModule), null, 2) : undefined,
  };
  return { ok: false, report, outputs: [], modules, graph };
}

export function compile(options: CompileOptions): CompileResult {
  const bag = new DiagnosticBag();
  const runtimeDts = options.runtimeDts
    ?? fileURLToPath(new URL("../../language/runtime.d.ts", import.meta.url));
  const outputName = options.outputName ?? "project.sb3";
  let requestedProfile = options.abiProfile ?? "auto";
  const modules: Module[] = [];
  let roles: RoleDecl[] = [];
  let target: Target = options.target ?? "scratch";
  let workspaceName = options.entry ?? "project";

  if (options.entry) {
    const config: FrontendConfig = { entry: options.entry, projectRoot: options.projectRoot, runtimeDts, bag };
    const typed = createTypedProgram(config);
    if (typed) modules.push(lowerToHIR(typed, config));
  } else {
    const workspace = loadWorkspace(options.projectRoot, bag, options.configPath);
    if (!workspace) {
      bag.error(
        CODES.TS_TYPE,
        "no --entry provided and no tscr.config.json found",
        undefined,
        ["Pass --entry <file> for a single-file build, or --config <path> for a role-based workspace."],
      );
      return failure(target, workspaceName, bag, selectProfile(requestedProfile, target), []);
    }
    roles = workspace.roles;
    workspaceName = workspace.config.name ?? resolve(options.projectRoot, options.configPath ?? ".");
    if (!options.target && workspace.config.target) target = workspace.config.target;
    if (!options.abiProfile && workspace.config.abiProfile) requestedProfile = workspace.config.abiProfile;
    for (const source of workspace.sources) {
      const config: FrontendConfig = {
        entry: source.file,
        projectRoot: options.projectRoot,
        runtimeDts,
        bag,
        role: { name: source.role, isStage: source.isStage },
      };
      const typed = createTypedProgram(config);
      if (typed) modules.push(lowerToHIR(typed, config));
    }
    if (modules.length === 0) {
      bag.error(CODES.TS_TYPE, `workspace ${workspaceName} has no .ts source files`);
    }
  }

  const entryLabel = options.entry ?? workspaceName;
  const abiProfile = selectProfile(requestedProfile, target);
  if (!isProfileAllowed(requestedProfile, target)) {
    bag.error(
      CODES.COMPAT,
      `--abi-profile ${requestedProfile} is not available for --target ${target}`,
      undefined,
      [
        `Allowed profiles for ${target}: ${allowedProfiles(target).join(", ")}.`,
        "--abi-profile and --target are orthogonal, but only supported combinations are accepted.",
      ],
    );
  } else if (requestedProfile === "extension" && abiProfile.lowering !== "extension") {
    bag.error(
      CODES.COMPAT,
      "--abi-profile extension is not implemented; only the native runtime emits ABI lowering",
      undefined,
      [
        "Value / Call / Frame / Memory / Dispatch operations still lower to native Scratch blocks on TurboWarp.",
        "Use --abi-profile auto (or native) until the TurboWarp E2E chain provides the Extension runtime.",
      ],
    );
  }
  const lowered = lowerControlFlow(modules);
  for (const module of lowered.modules) {
    validateModule(module, bag);
    validateYieldBoundaries(module, bag);
  }
  const optimized = options.optimize === false
    ? { modules: lowered.modules, stats: emptyOptimizationStats() }
    : optimizeModules(lowered.modules);
  const activeModules = optimized.modules;
  const optimization: OptimizationStats = {
    ...optimized.stats,
    controlFlowRewrites: lowered.stats.rewrites,
  };

  const plan = activeModules.length > 0
    ? planBackends(activeModules, target, bag, {
      maxBoundaryCalls: options.maxBoundaryCalls,
      seed: entryLabel,
      abiProfile: abiProfile.resolved,
      lowering: abiProfile.lowering,
    })
    : undefined;
  if (bag.hasErrors || !plan || activeModules.length === 0) {
    return failure(target, entryLabel, bag, abiProfile, plan?.entries ?? [], activeModules);
  }

  const { graph, builder } = lowerNative(activeModules, bag, {
    extensionOpcodes: plan.extensionOpcodes,
    extensionInputs: plan.extensionInputs,
    roles,
  });
  validateGraph(graph, bag);
  if (bag.hasErrors) return failure(target, entryLabel, bag, abiProfile, plan.entries, activeModules, graph);

  const bundle = generateExtension(plan, outputName);
  if (bundle) {
    graph.extensions = [bundle.id];
    graph.extensionURLs = { [bundle.id]: bundle.dataUrl };
  }

  const projectJson = buildProjectJson(graph, bag);
  const sb3 = exportSb3(graph, bag);
  if (bag.hasErrors) return failure(target, entryLabel, bag, abiProfile, plan.entries, activeModules, graph);

  const notes: string[] = [];
  if (bundle) {
    notes.push("Extension JS is embedded in project.json.extensionURLs as a data: URL; TurboWarp loads it automatically.");
    notes.push("Custom extension projects cannot be uploaded to the official Scratch website.");
    notes.push("TurboWarp Packager always runs extensions without the sandbox.");
    notes.push("Sandboxed extension calls cost at least one VM frame each.");
  }

  const reportSummary = {
    target,
    entry: entryLabel,
    ok: true,
    abiProfile,
    abiContracts: {
      required: plan.abiContracts,
      unsupported: plan.unsupported,
    },
    diagnostics: bag.items,
    plan: plan.entries,
    compatibility: {
      officialScratch: bundle === undefined,
      turboWarp: true,
      customExtensions: plan.regions.length,
      notes,
    },
    numericProfile: NUMERIC_PROFILE,
    optimization,
    sourceMap: builder.sourceMap,
    blockCount: builder.blockCount,
    boundaryCalls: plan.boundaryCalls,
    extensionId: plan.extensionId,
  };

  const outputs = assembleOutputs({
    sb3,
    sb3Filename: outputName,
    projectJson,
    report: reportSummary,
    sourceMap: builder.sourceMap,
    bundle,
  });

  const report: BuildReport = {
    ...reportSummary,
    outputs: outputs.map((file) => file.filename),
    hirDump: JSON.stringify(activeModules.map(printModule), null, 2),
    projectJson,
  };

  return { ok: true, report, sb3, outputs, modules: activeModules, graph, bundle, plan };
}

export function formatReport(report: BuildReport, explain = false): string {
  const lines = [
    `TypeScratch ${report.ok ? "build ok" : "build failed"}`,
    `  entry: ${report.entry}`,
    `  target: ${report.target}`,
    `  abi profile: ${report.abiProfile.requested} (resolved: ${report.abiProfile.resolved}, lowering: ${report.abiProfile.lowering})`,
    `  abi contracts: ${report.abiContracts.required.join(", ") || "none (static lowering only)"}`,
    `  blocks: ${report.blockCount}`,
    `  boundary calls: ${report.boundaryCalls}`,
    `  official Scratch compatible: ${report.compatibility.officialScratch ? "yes" : "no"}`,
    `  custom extensions: ${report.compatibility.customExtensions}`,
    `  numeric profile: ${report.numericProfile.model} (${report.numericProfile.documentedDifferences.length} documented differences)`,
    `  optimization: ${report.optimization.folded} folded, ${report.optimization.simplified} simplified, ` +
      `${report.optimization.branchesRemoved} branches, ${report.optimization.loopsRemoved} loops, ` +
      `${report.optimization.controlFlowRewrites} control-flow rewrites`,
    `  diagnostics: ${report.diagnostics.length}`,
  ];
  for (const output of report.outputs) lines.push(`  wrote: ${output}`);
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `${diagnostic.code} ${diagnostic.severity} ${
        diagnostic.span
          ? `${diagnostic.span.file}:${diagnostic.span.line}:${diagnostic.span.column}`
          : "<project>"
      }`,
      `  ${diagnostic.message}`,
      ...(diagnostic.details ?? []).map((detail) => `  ${detail}`),
    );
  }
  for (const note of report.compatibility.notes) lines.push(`  note: ${note}`);
  if (explain) {
    lines.push("  lowering plan:");
    for (const entry of report.plan) {
      lines.push(`    ${entry.decision.padEnd(9)} ${entry.operation} ${entry.detail} cost=${entry.cost}`);
    }
  }
  return lines.join("\n");
}
