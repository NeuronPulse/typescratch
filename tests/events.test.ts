import { test } from "vitest";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { compile } from "@typescratch/compiler";
import { interpretModules } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";
import { EXPECTED_EVENT_SAYS } from "./events.ts";

interface EventBlock {
  opcode: string;
  fields: Record<string, unknown>;
  topLevel: boolean;
}

interface EventProject {
  targets: {
    name: string;
    isStage: boolean;
    broadcasts: Record<string, string>;
    blocks: Record<string, EventBlock>;
  }[];
}

function build() {
  const result = compile({ entry: example("events"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  const files = unzipSync(result.sb3);
  const raw = files["project.json"];
  assert.ok(raw);
  return { result, project: JSON.parse(strFromU8(raw)) as EventProject };
}

test("typed hats lower to distinct IR kinds", () => {
  const { result } = build();
  const hats = result.modules[0]!.scripts.map((script) => script.hat);
  assert.deepEqual(hats, [
    { kind: "key", key: "space" },
    { kind: "spriteClicked" },
    { kind: "clone" },
    { kind: "backdrop", name: "Backdrop1" },
    { kind: "broadcast", name: "go" },
  ]);
  const legacy = compile({ entry: example("hello-native"), projectRoot: ROOT, target: "scratch" });
  assert.deepEqual(legacy.modules[0]?.scripts[0]?.hat, { kind: "flag" });
});

test("hat blocks carry the right opcodes, fields and broadcast registration", () => {
  const { project } = build();
  const stage = project.targets.find((target) => target.isStage)!;
  const sprite = project.targets.find((target) => !target.isStage)!;
  const hats = Object.values(sprite.blocks).filter((block) => block.topLevel);
  assert.equal(hats.length, 5);
  const opcodes = hats.map((block) => block.opcode);
  for (const opcode of [
    "event_whenkeypressed", "event_whenthisspriteclicked",
    "control_start_as_clone", "event_whenbackdropswitchesto", "event_whenbroadcastreceived",
  ]) {
    assert.ok(opcodes.includes(opcode), `missing ${opcode}`);
  }
  const keyHat = hats.find((block) => block.opcode === "event_whenkeypressed")!;
  assert.deepEqual(keyHat.fields["KEY_OPTION"], ["space", null]);
  const backdropHat = hats.find((block) => block.opcode === "event_whenbackdropswitchesto")!;
  assert.deepEqual(backdropHat.fields["BACKDROP"], ["Backdrop1", null]);
  const broadcastHat = hats.find((block) => block.opcode === "event_whenbroadcastreceived")!;
  const field = broadcastHat.fields["BROADCAST_OPTION"] as [string, string];
  assert.equal(field[0], "go");
  assert.equal(stage.broadcasts[field[1]], "go");
});

test("an invalid key is rejected by the TypeScript type checker", () => {
  const result = compile({ entry: example("event-type-error"), projectRoot: ROOT, target: "scratch" });
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((item) => item.code === "TSCR1001"));
});

test("the IR interpreter runs every event script", () => {
  const { result } = build();
  const trace = interpretModules(result.modules);
  assert.deepEqual([...trace.says].sort(), [...EXPECTED_EVENT_SAYS].sort());
});
