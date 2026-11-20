import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { ROOT } from "./helpers.ts";

const CONFIG = "examples/workspace/tscr.config.json";

interface TargetJson {
  name: string;
  isStage: boolean;
  x?: number;
  size?: number;
  blocks: Record<string, { opcode: string }>;
  costumes: { name: string; md5ext: string }[];
  sounds: unknown[];
  variables: Record<string, [string, unknown]>;
}

function build() {
  return compile({
    projectRoot: ROOT,
    configPath: CONFIG,
    outputName: "workspace.sb3",
  });
}

test("workspace maps files and folders to distinct Scratch roles", () => {
  const result = build();
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const names = (result.graph?.targets ?? []).map((target) => target.name).sort();
  assert.deepEqual(names, ["Enemy", "Hero", "Stage"]);
  assert.equal(result.modules.length, 4);
  assert.deepEqual(new Set(result.modules.map((module) => module.role?.name)), new Set(["Stage", "Hero", "Enemy"]));
});

test("scripts, variables and assets are attached to the owning role", () => {
  const result = build();
  const targets = new Map((result.graph?.targets ?? []).map((target) => [target.name, target]));
  const opcodes = (name: string): string[] =>
    [...(targets.get(name)?.blocks.values() ?? [])].map((block) => block.opcode);

  assert.ok(opcodes("Stage").includes("control_wait"));
  assert.ok(opcodes("Hero").includes("looks_say"));
  assert.equal(opcodes("Enemy").filter((opcode) => opcode === "event_whenflagclicked").length, 2);
  assert.equal(opcodes("Enemy").filter((opcode) => opcode === "looks_say").length, 2);

  const stageVariables = Object.values(targets.get("Stage")!.variables);
  assert.ok(stageVariables.some(([name, value]) => name === "hp" && value === 10));
  const heroVariables = Object.values(targets.get("Hero")!.variables);
  // Private temps are named with their owning role so the .sb3 is readable.
  assert.ok(heroVariables.some(([name]) => name.startsWith("Hero_s")), JSON.stringify(heroVariables.map(([n]) => n)));

  const heroCostume = targets.get("Hero")!.costumes[0];
  assert.ok(heroCostume);
  assert.equal(heroCostume.name, "hero");
  assert.equal(heroCostume.dataFormat, "svg");
  assert.ok(result.graph?.assets.has(heroCostume.assetKey));
  assert.equal(targets.get("Hero")!.x, 40);
  assert.equal(targets.get("Hero")!.size, 80);
});

test("workspace sb3 has role-scoped targets and resolved assets", () => {
  const result = build();
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  const project = JSON.parse(strFromU8(raw)) as {
    targets: TargetJson[];
    extensions: string[];
    extensionURLs?: Record<string, string>;
  };
  assert.equal(project.targets.length, 3);
  assert.deepEqual(project.extensions, []);
  assert.equal(project.extensionURLs, undefined);
  const hero = project.targets.find((target) => target.name === "Hero");
  assert.ok(hero);
  assert.equal(hero.costumes[0]?.name, "hero");
  assert.deepEqual(hero.sounds, []);
  assert.equal(hero.x, 40);
  assert.ok(hero.costumes[0]);
  assert.ok(files[hero.costumes[0].md5ext]);
  assert.equal(Object.keys(hero.blocks).some((id) => hero.blocks[id]?.opcode === "looks_say"), true);
});

test("missing entry and config produce a clear diagnostic", () => {
  const result = compile({ projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, false);
  const diagnostic = result.report.diagnostics.find((item) => item.code === "TSCR1001");
  assert.ok(diagnostic);
  assert.ok(diagnostic.details?.some((detail) => detail.includes("--config")));
});
