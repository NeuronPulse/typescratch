import { test } from "vitest";
import assert from "node:assert/strict";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";
import { createStepSession, type StepSession } from "@typescratch/testing";

const NEXT_ID = "v_next";
const NEXT_NAME = "nextId";
const TOKENS_ID = "l_tokens";
const TOKENS_NAME = "tokens";
const KEY_HAT = "event_whenkeypressed";
const KEY_FIELDS = { KEY_OPTION: "space" };

interface ScriptSpec {
  hat: "flag" | "key";
  slot: string;
  yieldBetween?: boolean;
  repeat?: number;
}

function slotId(spec: ScriptSpec): string {
  return `v_slot_${spec.slot}`;
}

function slotName(spec: ScriptSpec): string {
  return `slot_${spec.slot}`;
}

function buildProject(specs: ScriptSpec[]): Uint8Array {
  const bag = new DiagnosticBag();
  const builder = new GraphBuilder();
  builder.declareVariable(NEXT_ID, NEXT_NAME, 0, "local");
  builder.declareList(TOKENS_ID, TOKENS_NAME, []);
  for (const spec of specs) {
    builder.declareVariable(slotId(spec), slotName(spec), 0, "local");
  }

  specs.forEach((spec, index) => {
    const scope = `token:${index}`;
    const hat = spec.hat === "flag"
      ? builder.add("event_whenflagclicked", { scope, topLevel: true, x: 40, y: 40 + index * 320 })
      : builder.add(KEY_HAT, {
        scope, topLevel: true, x: 40, y: 40 + index * 320,
        fields: { KEY_OPTION: ["space", null] },
      });

    const read = builder.add("data_setvariableto", {
      scope, fields: { VARIABLE: [slotName(spec), slotId(spec)] },
    });
    builder.input(read, "VALUE", { obscuredPrimitive: [12, NEXT_NAME, NEXT_ID] });
    const inner: string[] = [read];

    if (spec.yieldBetween) {
      const wait = builder.add("control_wait", { scope });
      builder.input(wait, "DURATION", { primitive: [4, "0"] });
      inner.push(wait);
    }

    const bump = builder.add("data_changevariableby", {
      scope, fields: { VARIABLE: [NEXT_NAME, NEXT_ID] },
    });
    builder.input(bump, "VALUE", { primitive: [4, "1"] });
    inner.push(bump);

    const record = builder.add("data_addtolist", {
      scope, fields: { LIST: [TOKENS_NAME, TOKENS_ID] },
    });
    builder.input(record, "ITEM", { obscuredPrimitive: [12, slotName(spec), slotId(spec)] });
    inner.push(record);

    if (spec.repeat) {
      const loop = builder.add("control_repeat", { scope });
      builder.input(loop, "TIMES", { primitive: [4, String(spec.repeat)] });
      builder.chain([hat, loop]);
      builder.chain(inner);
      builder.substack(loop, "SUBSTACK", inner[0]!);
    } else {
      builder.chain([hat, ...inner]);
    }
  });

  assert.equal(bag.items.length, 0, JSON.stringify(bag.items));
  return exportSb3(builder.project, bag);
}

async function runTokens(
  specs: ScriptSpec[],
  start: (session: StepSession) => void,
): Promise<(string | number | boolean)[]> {
  const session = await createStepSession(buildProject(specs));
  try {
    start(session);
    for (let step = 0; step < 80 && session.activeThreads() > 0; step++) session.step();
    return session.lists()[`Sprite1:${TOKENS_NAME}`] ?? [];
  } finally {
    session.close();
  }
}

function sortedNumbers(tokens: (string | number | boolean)[]): number[] {
  return tokens.map(Number).sort((left, right) => left - right);
}

test("two different hats allocate distinct tokens in a yield-free sequence", async () => {
  const tokens = await runTokens(
    [{ hat: "flag", slot: "a" }, { hat: "key", slot: "b" }],
    (session) => {
      session.greenFlag();
      session.startHat(KEY_HAT, KEY_FIELDS);
    },
  );
  assert.deepEqual(sortedNumbers(tokens), [0, 1]);
});

test("restarting the same key hat while it is live does not start a second thread", async () => {
  const tokens = await runTokens(
    [{ hat: "key", slot: "a" }],
    (session) => {
      session.startHat(KEY_HAT, KEY_FIELDS);
      session.startHat(KEY_HAT, KEY_FIELDS);
    },
  );
  assert.deepEqual(sortedNumbers(tokens), [0]);
});

test("restarting the same key hat after it finishes allocates a fresh token", async () => {
  const tokens = await runTokens(
    [{ hat: "key", slot: "a" }],
    (session) => {
      session.startHat(KEY_HAT, KEY_FIELDS);
      for (let step = 0; step < 8 && session.activeThreads() > 0; step++) session.step();
      session.startHat(KEY_HAT, KEY_FIELDS);
    },
  );
  assert.deepEqual(sortedNumbers(tokens), [0, 1]);
});

test("loop boundaries do not corrupt allocation while another script runs", async () => {
  const tokens = await runTokens(
    [{ hat: "flag", slot: "a", repeat: 3 }, { hat: "key", slot: "b" }],
    (session) => {
      session.greenFlag();
      session.startHat(KEY_HAT, KEY_FIELDS);
    },
  );
  assert.deepEqual(sortedNumbers(tokens), [0, 1, 2, 3]);
});

test("an allowed yield between read and write breaks token atomicity", async () => {
  const tokens = await runTokens(
    [
      { hat: "flag", slot: "a", yieldBetween: true },
      { hat: "key", slot: "b", yieldBetween: true },
    ],
    (session) => {
      session.greenFlag();
      session.startHat(KEY_HAT, KEY_FIELDS);
    },
  );
  assert.equal(tokens.length, 2, `expected both threads to record, got ${JSON.stringify(tokens)}`);
  assert.ok(
    new Set(tokens).size < tokens.length,
    `yield must expose the shared counter to both threads, got ${JSON.stringify(tokens)}`,
  );
});
