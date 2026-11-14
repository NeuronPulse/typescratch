import { test } from "vitest";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { capabilityFor } from "@typescratch/backend-planner";
import { extensionIdFor } from "@typescratch/runtime-abi";
import { example, ROOT } from "./helpers.ts";

interface GeneratedBlock {
  opcode: string;
  inputs: Record<string, unknown>;
}

interface GeneratedProject {
  extensions: string[];
  extensionURLs?: Record<string, string>;
  targets: { blocks: Record<string, GeneratedBlock> }[];
}

function hybrid() {
  return compile({
    entry: example("hybrid"),
    projectRoot: ROOT,
    target: "turbowarp",
    outputName: "hybrid.sb3",
  });
}

function projectOf(result: ReturnType<typeof compile>): GeneratedProject {
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  return JSON.parse(strFromU8(raw)) as GeneratedProject;
}

test("capability matrix separates native math from extension-only math", () => {
  assert.deepEqual(capabilityFor("math.sqrt"), {
    native: "supported", extension: "unsupported", cost: "low",
  });
  assert.deepEqual(capabilityFor("ext.Math.hypot"), {
    native: "unsupported", extension: "supported", cost: "medium",
  });
});

test("extension ids and generated code are deterministic", () => {
  const first = hybrid();
  const second = hybrid();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.bundle?.id, second.bundle?.id);
  assert.equal(first.bundle?.code, second.bundle?.code);
  assert.equal(first.bundle?.dataUrl, second.bundle?.dataUrl);
  assert.equal(extensionIdFor("a.ts", ["ext.Math.hypot"]), extensionIdFor("a.ts", ["ext.Math.hypot"]));
});

test("generated extension follows the TurboWarp getInfo contract", () => {
  const result = hybrid();
  assert.ok(result.bundle);
  const code = result.bundle.code;
  assert.match(code, /Scratch\.extensions\.register\(new TypeScratchGenerated\(\)\)/);
  assert.match(code, /getInfo\(\)/);
  assert.match(code, /Scratch\.BlockType\.REPORTER/);
  assert.match(code, /Scratch\.ArgumentType\.NUMBER/);
  assert.match(code, /const A = Number\(args\.A\)/);
  assert.match(code, /try \{/);
  assert.doesNotMatch(code, /\beval\b/);
  assert.match(code, /tscr_intrinsic_math_hypot/);
  assert.match(code, /tscr_intrinsic_string_upper/);
  assert.equal(result.bundle.manifest.compatibility.officialScratch, false);
  assert.equal(result.bundle.manifest.extension.sandbox, "sandboxed");
  assert.equal(result.bundle.manifest.embedding.projectJsonField, "extensionURLs");
  assert.ok(result.bundle.manifest.extension.opcodes.length >= 2);
});

test("extension JS is embedded in project.json.extensionURLs as a data URL", () => {
  const result = hybrid();
  assert.equal(result.ok, true);
  assert.ok(result.bundle);
  const project = projectOf(result);
  const id = result.bundle.id;

  assert.deepEqual(project.extensions, [id]);
  assert.ok(project.extensionURLs);
  const url = project.extensionURLs[id];
  assert.ok(url);
  assert.equal(new URL(url).protocol, "data:");
  assert.ok(url.startsWith("data:application/javascript;base64,"));
  const base64 = url.slice(url.indexOf(",") + 1);
  assert.equal(Buffer.from(base64, "base64").toString("utf8"), result.bundle.code);
  assert.equal(result.bundle.dataUrl, url);
  assert.ok(result.report.compatibility.notes.some((note) => note.includes("extensionURLs")));
});

test("hybrid project mixes native blocks and extension opcodes", () => {
  const result = hybrid();
  assert.equal(result.ok, true);
  const project = projectOf(result);
  const blocks = Object.values(project.targets[1]!.blocks);
  const opcodes = blocks.map((block) => block.opcode);
  assert.equal(opcodes.filter((opcode) => opcode === "looks_say").length, 3);
  assert.equal(opcodes.filter((opcode) => opcode === "operator_add").length, 0);
  const unoptimized = compile({
    entry: example("hybrid"),
    projectRoot: ROOT,
    target: "turbowarp",
    outputName: "hybrid.sb3",
    optimize: false,
  });
  assert.equal(unoptimized.ok, true);
  const rawOpcodes = Object.values(projectOf(unoptimized).targets[1]!.blocks)
    .map((block) => block.opcode);
  assert.equal(rawOpcodes.filter((opcode) => opcode === "operator_add").length, 1);
  assert.ok(opcodes.some((opcode) => opcode.includes("tscr_intrinsic_math_hypot")));
  assert.ok(opcodes.some((opcode) => opcode.includes("tscr_intrinsic_string_upper")));
  assert.ok(opcodes.every((opcode) => !opcode.startsWith(`${result.bundle!.id}_`) || opcode.startsWith(`${result.bundle!.id}_`)));
  assert.equal(result.report.boundaryCalls, 2);
  assert.ok(result.report.plan.some((entry) => entry.decision === "extension"));
  assert.ok(result.report.plan.some((entry) => entry.decision === "native"));
});

test("block opcode prefixes resolve to the embedded extension id using scratch-vm's own parser", () => {
  const result = hybrid();
  assert.equal(result.ok, true);
  assert.ok(result.bundle);
  const project = projectOf(result);
  const require = createRequire(import.meta.url);
  const vmRoot = realpathSync(resolve(ROOT, "node_modules/scratch-vm"));
  const sb3 = require(`${vmRoot}/src/serialization/sb3.js`) as {
    getExtensionIdForOpcode(opcode: string): string | undefined;
  };
  const customOpcodes = Object.values(project.targets[1]!.blocks)
    .map((block) => block.opcode)
    .filter((opcode) => opcode.startsWith("tscr"));
  assert.ok(customOpcodes.length >= 2);
  for (const opcode of customOpcodes) {
    const extensionId = sb3.getExtensionIdForOpcode(opcode);
    assert.equal(extensionId, result.bundle.id);
    assert.ok(project.extensions.includes(extensionId));
    assert.ok(project.extensionURLs?.[extensionId]);
  }
});

test("scratch target never writes extensionURLs", () => {
  const result = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  const project = projectOf(result);
  assert.deepEqual(project.extensions, []);
  assert.equal(project.extensionURLs, undefined);
});

test("hybrid source cannot be built for the scratch target", () => {
  const result = compile({ entry: example("hybrid"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.filter((item) => item.code === "TSCR5001").length >= 2);
});
