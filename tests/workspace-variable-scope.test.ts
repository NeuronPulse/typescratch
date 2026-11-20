import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";

/**
 * Scope in the emitted .sb3 must be recognizable (role + scope in the name)
 * and unique across workspace modules. Scratch global == cross-sprite visible;
 * local/temp == private to the declaring role.
 */
function compileWorkspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "tscr-scope-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, "src", name), source);
  }
  writeFileSync(join(root, "tscr.config.json"), JSON.stringify({ name: "scope-test", target: "scratch", src: "src", assets: "assets" }));
  return compile({ configPath: join(root, "tscr.config.json"), projectRoot: root, target: "scratch" });
}

const header = `import { Scratch } from "@typescratch/runtime";\n`;

test("same-name locals in two roles are distinct and recognizable", () => {
  const result = compileWorkspace({
    "Hero.ts": header + `
let counter = 0;
Scratch.onFlag(() => { counter = counter + 1; Scratch.say("" + counter); });
`,
    "Enemy.ts": header + `
let counter = 0;
Scratch.onFlag(() => { counter = counter + 10; Scratch.say("" + counter); });
`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const hero = result.modules.find((m) => m.role?.name === "Hero")!;
  const enemy = result.modules.find((m) => m.role?.name === "Enemy")!;
  const heroVar = hero.vars.find((v) => v.name.endsWith(".counter"))!;
  const enemyVar = enemy.vars.find((v) => v.name.endsWith(".counter"))!;
  assert.ok(heroVar, "Hero has a variable named counter");
  assert.ok(enemyVar, "Enemy has a variable named counter");
  assert.notEqual(heroVar.id, enemyVar.id, "IDs must be unique across roles");
  // The emitted names carry the role so a human reading the .sb3 can tell.
  assert.ok(heroVar.id.includes("Hero") && enemyVar.id.includes("Enemy"));
});

test("a stage global exists, but another role cannot name it until M4 (cross-module)", () => {
  const stageOnly = compileWorkspace({
    "Stage.ts": header + `/** @global */\nlet shared = 5;\n`,
    "Hero.ts": header + `Scratch.onFlag(() => { Scratch.say("hero"); });\n`,
  });
  assert.equal(stageOnly.ok, true, JSON.stringify(stageOnly.report.diagnostics));
  const stage = stageOnly.modules.find((m) => m.role?.name === "Stage")!;
  assert.ok(stage.vars.some((v) => v.storage === "global" && v.name === "shared"));
  // Cross-role reference is rejected by TypeScript itself: each source is an
  // independent ts.Program (compiler/src/index.ts:182-183). M4 will add a
  // shared symbol table; until then this is an explicit, diagnosed boundary.
  const cross = compileWorkspace({
    "Stage.ts": header + `/** @global */\nlet shared = 5;\n`,
    "Hero.ts": header + `Scratch.onFlag(() => { Scratch.say("" + shared); });\n`,
  });
  assert.equal(cross.ok, false);
  assert.ok(cross.report.diagnostics.some((d) => d.code === "TSCR1001" && /shared/.test(d.message)),
    JSON.stringify(cross.report.diagnostics));
});
