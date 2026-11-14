import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { loadWorkspace } from "@typescratch/workspace";
import { example, ROOT } from "./helpers.ts";

const TEMPLATE = "packages/workspace/template/tscr.config.json";
const TEMPLATE_ROOT = resolve(ROOT, "packages/workspace/template");

interface BlockJson {
  opcode: string;
  inputs: Record<string, unknown>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
}

interface CostumeJson {
  name: string;
  assetId: string;
  md5ext: string;
  dataFormat: string;
  bitmapResolution: number;
  rotationCenterX: number;
  rotationCenterY: number;
}

interface ProjectJson {
  targets: {
    name: string;
    isStage: boolean;
    blocks: Record<string, BlockJson>;
    costumes: CostumeJson[];
  }[];
}

function buildDefault() {
  return compile({ projectRoot: ROOT, configPath: TEMPLATE, outputName: "default.sb3" });
}

function unzip(result: ReturnType<typeof compile>): { project: ProjectJson; files: Record<string, Uint8Array> } {
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  return { project: JSON.parse(strFromU8(raw)) as ProjectJson, files };
}

function allInputs(project: ProjectJson): unknown[] {
  return project.targets.flatMap((target) =>
    Object.values(target.blocks).flatMap((block) => Object.values(block.inputs)),
  );
}

test("default workspace follows the jvavscratch Sprite1 layout", () => {
  const bag = new DiagnosticBag();
  const workspace = loadWorkspace(ROOT, bag, TEMPLATE);
  assert.ok(workspace);
  assert.equal(workspace.config.name, "my-project");
  assert.deepEqual(workspace.roles.map((role) => role.name).sort(), ["Sprite1", "Stage"]);
  assert.equal(workspace.sources.length, 1);
  assert.equal(workspace.sources[0]?.role, "Sprite1");
  assert.equal(bag.items.length, 0);
  for (const file of [
    "project.d.json",
    "src/Sprite1.ts",
    "assets/Sprite1/costumes/costumes.json",
    "assets/Sprite1/costumes/default.svg",
    "assets/stage/backdrops/backdrops.json",
    "assets/stage/backdrops/stage.svg",
  ]) {
    assert.equal(existsSync(resolve(TEMPLATE_ROOT, file)), true, `missing ${file}`);
  }
});

test("default project uses the ice cream costume and blank backdrop", () => {
  const result = buildDefault();
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const { project, files } = unzip(result);
  assert.deepEqual(project.targets.map((target) => target.name), ["Stage", "Sprite1"]);

  const stage = project.targets.find((target) => target.isStage)!;
  const sprite = project.targets.find((target) => target.name === "Sprite1")!;
  assert.equal(stage.costumes[0]?.name, "Backdrop1");
  assert.equal(sprite.costumes[0]?.name, "Costume1");
  for (const costume of [stage.costumes[0]!, sprite.costumes[0]!]) {
    assert.equal(costume.dataFormat, "svg");
    assert.equal(costume.bitmapResolution, 2);
    assert.equal(costume.rotationCenterX, 0);
    assert.equal(costume.rotationCenterY, 0);
  }

  const iceCream = readFileSync(resolve(TEMPLATE_ROOT, "assets/Sprite1/costumes/default.svg"));
  const backdrop = readFileSync(resolve(TEMPLATE_ROOT, "assets/stage/backdrops/stage.svg"));
  assert.equal(sprite.costumes[0].assetId, createHash("md5").update(iceCream).digest("hex"));
  assert.equal(stage.costumes[0].assetId, createHash("md5").update(backdrop).digest("hex"));
  assert.deepEqual(files[sprite.costumes[0].md5ext], new Uint8Array(iceCream));
  assert.deepEqual(files[stage.costumes[0].md5ext], new Uint8Array(backdrop));
});

test("every block carries x/y and the shadow flag", () => {
  const result = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  const { project } = unzip(result);
  const blocks = project.targets.flatMap((target) => Object.values(target.blocks));
  assert.ok(blocks.length >= 2);
  for (const block of blocks) {
    assert.equal(typeof block.x, "number", `${block.opcode} missing x`);
    assert.equal(typeof block.y, "number", `${block.opcode} missing y`);
    assert.equal(typeof block.shadow, "boolean", `${block.opcode} missing shadow`);
  }
});

test("inputs use jvavscratch's literal, obscured-shadow and substack encodings", () => {
  const result = compile({ entry: example("calc"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  const { project } = unzip(result);
  const inputs = allInputs(project) as unknown[][];
  const isHiddenShadow = (input: unknown[]): boolean =>
    input[0] === 3 && Array.isArray(input[2]) && input[2][0] === 4 && input[2][1] === "";

  assert.ok(inputs.some((input) => input[0] === 1 && Array.isArray(input[1]) && input[1][0] === 10), "literal text shadow");
  assert.ok(inputs.some((input) => isHiddenShadow(input) && typeof input[1] === "string"), "reporter block with hidden shadow");
  assert.ok(inputs.some((input) => isHiddenShadow(input) && Array.isArray(input[1]) && input[1][0] === 12), "variable reporter with hidden shadow");
  assert.ok(inputs.some((input) => input[0] === 2 && typeof input[1] === "string"), "substack input");
  for (const input of inputs) {
    if (input[0] === 3) assert.equal(isHiddenShadow(input), true, "type-3 input must carry its hidden shadow");
  }
});

test("official scratch-vm reconstructs shadow blocks from our inputs", () => {
  const result = compile({ entry: example("calc"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true);
  const { project } = unzip(result);
  const require = createRequire(import.meta.url);
  const vmRoot = realpathSync(resolve(ROOT, "node_modules/scratch-vm"));
  const sb3 = require(`${vmRoot}/src/serialization/sb3.js`) as {
    deserializeBlocks(blocks: Record<string, unknown>): Record<string, unknown>;
  };
  for (const target of project.targets) {
    if (Object.keys(target.blocks).length === 0) continue;
    const parsed = sb3.deserializeBlocks(structuredClone(target.blocks) as Record<string, unknown>);
    const blocks = Object.values(parsed) as { shadow?: boolean; opcode?: string }[];
    const shadows = blocks.filter((block) => block.shadow === true);
    assert.ok(shadows.length >= 2, `${target.name} has no reconstructed shadows`);
    assert.ok(shadows.some((block) => block.opcode === "math_number"));
  }
});

test("tscr init scaffolds the default workspace", () => {
  const parent = mkdtempSync(resolve(ROOT, "dist/init-"));
  const directory = resolve(parent, "project");
  try {
    execFileSync(process.execPath, [resolve(ROOT, "packages/cli/src/bin.ts"), "init", directory], {
      cwd: ROOT,
      stdio: "pipe",
    });
    assert.equal(existsSync(resolve(directory, "tscr.config.json")), true);
    assert.equal(existsSync(resolve(directory, "src/Sprite1.ts")), true);
    assert.equal(existsSync(resolve(directory, "assets/Sprite1/costumes/default.svg")), true);
    assert.equal(existsSync(resolve(directory, "assets/stage/backdrops/stage.svg")), true);
    const compiled = compile({
      projectRoot: directory,
      configPath: "tscr.config.json",
      outputName: "init.sb3",
      runtimeDts: resolve(ROOT, "packages/language/runtime.d.ts"),
    });
    assert.equal(compiled.ok, true, JSON.stringify(compiled.report.diagnostics));
    assert.deepEqual(
      compiled.graph?.targets.map((target) => target.name),
      ["Stage", "Sprite1"],
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
