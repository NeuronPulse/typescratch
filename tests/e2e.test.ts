import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { example, ROOT } from "./helpers.ts";

interface JsonBlock {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, unknown>;
  fields: Record<string, unknown>;
  shadow: boolean;
  topLevel: boolean;
}

interface JsonTarget {
  isStage: boolean;
  name: string;
  variables: Record<string, [string, unknown]>;
  blocks: Record<string, JsonBlock>;
  costumes: { md5ext: string }[];
}

interface JsonProject {
  targets: JsonTarget[];
  monitors: unknown[];
  extensions: string[];
  meta: { semver: string; vm: string; agent: string };
}

function build(name: string) {
  const result = compile({ entry: example(name), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  const project = JSON.parse(strFromU8(raw)) as JsonProject;
  const sprite = project.targets.find((target) => !target.isStage);
  assert.ok(sprite);
  return { result, files, project, sprite };
}

test("hello native slice produces a structurally valid sb3", () => {
  const { result, files, project, sprite } = build("hello-native");
  assert.equal(result.report.diagnostics.length, 0);
  assert.equal(project.meta.semver, "3.0.0");
  assert.deepEqual(project.extensions, []);
  assert.equal(project.targets.filter((target) => target.isStage).length, 1);

  const found = Object.entries(sprite.blocks).find(([, block]) => block.opcode === "event_whenflagclicked");
  assert.ok(found);
  const [hatId, hat] = found;
  assert.equal(hat.topLevel, true);
  assert.equal(hat.parent, null);

  const sayId = hat.next;
  assert.ok(sayId);
  const say = sprite.blocks[sayId];
  assert.ok(say);
  assert.equal(say.opcode, "looks_say");
  assert.equal(say.parent, hatId);
  assert.equal(say.next, null);
  const message = say.inputs["MESSAGE"] as [number, unknown];
  assert.equal(message[0], 1);
  assert.deepEqual(message[1], [10, "Hello from TypeScratch!"]);

  const md5ext = sprite.costumes[0]?.md5ext;
  assert.ok(md5ext);
  assert.ok(files[md5ext]);
  assert.ok(result.report.sourceMap.length > 0);
  assert.equal(result.report.compatibility.officialScratch, true);
});

test("build output is deterministic", () => {
  const first = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  const second = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  assert.equal(first.report.projectJson, second.report.projectJson);
  assert.deepEqual(Buffer.from(first.sb3!), Buffer.from(second.sb3!));
});

test("calc example lowers control flow, resources and native math", () => {
  const { result, project, sprite } = build("calc");
  const opcodes = new Set(Object.values(sprite.blocks).map((block) => block.opcode));
  for (const opcode of [
    "control_repeat_until", "control_if_else", "operator_mod",
    "operator_mathop", "operator_join", "data_setvariableto", "operator_not",
  ]) {
    assert.ok(opcodes.has(opcode), `missing opcode ${opcode}`);
  }
  const mathop = Object.values(sprite.blocks).find((block) => block.opcode === "operator_mathop");
  assert.ok(mathop);
  assert.deepEqual(mathop.fields["OPERATOR"], ["sqrt", null]);
  const numInput = mathop.inputs["NUM"] as [number, unknown, unknown];
  assert.equal(numInput[0], 3);
  assert.deepEqual(numInput[2], [4, ""]);

  const stage = project.targets.find((target) => target.isStage);
  assert.ok(stage);
  const globals = Object.values(stage.variables);
  assert.ok(globals.some(([name, value]) => name === "score" && value === 9));
  assert.ok(result.report.diagnostics.some((item) => item.code === "TSCR2003"));
});
