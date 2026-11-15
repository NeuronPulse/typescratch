import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

const KEY_HAT = "event_whenkeypressed";
const KEY_FIELDS = { KEY_OPTION: "space" };
const EXPECTED = ["A5", "B3"];

function build() {
  return compile({
    entry: example("reentrant-break"),
    projectRoot: ROOT,
    target: "scratch",
  });
}

interface JsonTarget {
  isStage: boolean;
  variables: Record<string, unknown>;
  blocks: Record<string, {
    fields: Record<string, [string, string | null]>;
    inputs: Record<string, unknown>;
  }>;
}

interface JsonProject {
  targets: JsonTarget[];
}

function collapseControlFlowPartition(sb3: Uint8Array): Uint8Array {
  const files = unzipSync(sb3);
  const project = JSON.parse(strFromU8(files["project.json"]!)) as JsonProject;
  const target = project.targets.find((entry) => !entry.isStage)!;
  const aliases = new Map<string, string>();
  for (const id of Object.keys(target.variables)) {
    if (id.startsWith("vcf_0_1_")) aliases.set(id, `vcf_0_0_${id.slice("vcf_0_1_".length)}`);
  }
  assert.ok(aliases.size > 0, "expected control-flow temporaries for the second script");

  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return aliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, replace(nested)]),
      );
    }
    return value;
  };

  for (const block of Object.values(target.blocks)) {
    for (const [name, field] of Object.entries(block.fields)) {
      const alias = field[1] ? aliases.get(field[1]) : undefined;
      if (alias) block.fields[name] = [field[0], alias];
    }
    for (const [name, input] of Object.entries(block.inputs)) {
      block.inputs[name] = replace(input);
    }
  }
  for (const id of aliases.keys()) delete target.variables[id];

  return zipSync(
    { ...files, "project.json": strToU8(JSON.stringify(project)) },
    { level: 6, mtime: new Date("2000-01-01T00:00:00Z") },
  );
}

interface InterleavedRun {
  says: string[];
  concurrentThreads: number;
}

async function runInterleaved(sb3: Uint8Array): Promise<InterleavedRun> {
  const session = await createStepSession(sb3);
  try {
    session.greenFlag();
    session.startHat(KEY_HAT, KEY_FIELDS);
    const concurrentThreads = session.activeThreads();
    for (let step = 0; step < 120 && session.activeThreads() > 0; step++) session.step();
    return { says: [...session.says].sort(), concurrentThreads };
  } finally {
    session.close();
  }
}

test("control-flow temporaries are partitioned per script", () => {
  const result = build();
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.equal(result.report.optimization.controlFlowRewrites, 2);
  const controlVars = result.modules[0]!.vars.filter((decl) => decl.id.startsWith("vcf_"));
  assert.equal(controlVars.length, 4);
  const grouped = new Map<number, string[]>();
  for (const decl of controlVars) {
    const key = decl.script ?? -1;
    grouped.set(key, [...(grouped.get(key) ?? []), decl.id]);
  }
  assert.equal(grouped.size, 2);
  const [first, second] = [...grouped.values()];
  assert.ok(first!.every((id) => !second!.includes(id)));
});

test("concurrent rewritten loops keep independent break semantics in the real VM", async () => {
  const result = build();
  assert.ok(result.sb3);
  const run = await runInterleaved(result.sb3);
  assert.equal(run.concurrentThreads, 2, "both scripts must be live at the same time");
  assert.deepEqual(run.says, EXPECTED);
});

test("collapsing the per-script partition breaks the loops in the real VM", async () => {
  const result = build();
  assert.ok(result.sb3);
  const run = await runInterleaved(collapseControlFlowPartition(result.sb3));
  assert.equal(run.concurrentThreads, 2, "both scripts must be live at the same time");
  assert.deepEqual(
    run.says,
    ["A3", "B3"],
    "shared done/skip must stop the other loop early; isolation cannot rest on a warning",
  );
});
