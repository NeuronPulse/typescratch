import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "@typescratch/compiler";
import { example } from "./helpers.ts";

export interface GoldenCase {
  name: string;
  entry: string;
  target: "scratch" | "turbowarp";
}

export const GOLDEN_CASES: GoldenCase[] = [
  { name: "hybrid", entry: example("hybrid"), target: "turbowarp" },
  { name: "calc", entry: example("calc"), target: "scratch" },
  { name: "events", entry: example("events"), target: "scratch" },
  { name: "ir-opt", entry: example("ir-opt"), target: "scratch" },
  { name: "break-continue", entry: example("break-continue"), target: "scratch" },
  { name: "function-return", entry: example("function-return"), target: "scratch" },
  { name: "memory-object", entry: example("memory-object"), target: "scratch" },
  { name: "abstract-equality", entry: example("abstract-equality"), target: "scratch" },
  { name: "edge-hat", entry: example("edge-hat"), target: "scratch" },
  { name: "function-recursion", entry: example("function-recursion"), target: "scratch" },
];

export const GOLDEN_ARTIFACTS = [
  "hir.json",
  "backend-plan.json",
  "graph.json",
  "extension.js",
  "build-report.json",
] as const;

export function goldenDir(root: string, name: string): string {
  return resolve(root, "tests/__snapshots__", name);
}

export function collectGolden(root: string, item: GoldenCase): Record<string, string> {
  const result = compile({
    entry: item.entry,
    projectRoot: root,
    target: item.target,
    outputName: `${item.name}.sb3`,
  });
  if (!result.ok) {
    throw new Error(`golden case ${item.name} failed to compile: ${JSON.stringify(result.report.diagnostics)}`);
  }
  const plan = result.plan;
  return {
    "hir.json": `${result.report.hirDump ?? "[]"}\n`,
    "backend-plan.json": `${JSON.stringify({
      entries: plan?.entries ?? [],
      regions: (plan?.regions ?? []).map((region) => ({
        id: region.id,
        intrinsic: region.intrinsic,
        opcode: region.opcode,
        occurrences: region.occurrences,
      })),
      extensionId: plan?.extensionId ?? null,
      boundaryCalls: plan?.boundaryCalls ?? 0,
      nativeOps: plan?.nativeOps ?? 0,
    }, null, 2)}\n`,
    "graph.json": `${result.report.projectJson ?? "{}"}\n`,
    "extension.js": result.bundle?.code ?? "// no custom extension for the scratch target\n",
    "build-report.json": `${JSON.stringify(result.report, null, 2)}\n`,
  };
}

export function compareGolden(root: string): string[] {
  const diffs: string[] = [];
  for (const item of GOLDEN_CASES) {
    const artifacts = collectGolden(root, item);
    for (const name of GOLDEN_ARTIFACTS) {
      const path = resolve(goldenDir(root, item.name), name);
      if (!existsSync(path)) {
        diffs.push(`missing ${item.name}/${name} (run pnpm snapshots:update)`);
        continue;
      }
      const expected = readFileSync(path, "utf8");
      if (expected !== artifacts[name]) {
        diffs.push(`mismatch ${item.name}/${name}: expected ${expected.length} bytes, got ${artifacts[name]!.length}`);
      }
    }
  }
  return diffs;
}

export function updateGolden(root: string): string[] {
  const written: string[] = [];
  for (const item of GOLDEN_CASES) {
    const directory = goldenDir(root, item.name);
    mkdirSync(directory, { recursive: true });
    const artifacts = collectGolden(root, item);
    for (const name of GOLDEN_ARTIFACTS) {
      const path = resolve(directory, name);
      writeFileSync(path, artifacts[name]!);
      written.push(`tests/__snapshots__/${item.name}/${name}`);
    }
  }
  return written;
}
