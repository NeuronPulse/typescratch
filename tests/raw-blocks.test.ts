import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { compile } from "@typescratch/compiler";
import { createStepSession } from "@typescratch/testing";

/** Generic Scratch block escape hatch: Scratch.do / Scratch.get emit ANY block by opcode. */
function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-raw-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

function project(sb3: Uint8Array): { targets: { blocks: Record<string, {
  opcode: string; fields?: Record<string, [string, string | null]>;
}> }[] } {
  const view = new DataView(sb3.buffer, sb3.byteOffset, sb3.byteLength);
  let offset = 0;
  while (offset + 30 <= sb3.byteLength) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = Buffer.from(sb3.buffer, sb3.byteOffset + offset + 30, nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    if (name === "project.json") {
      const raw = sb3.subarray(start, start + size);
      return JSON.parse((method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    }
    offset = start + size;
  }
  throw new Error("project.json not found");
}

const ops = (sb3: Uint8Array): string[] => [...new Set(project(sb3).targets
  .flatMap((t) => Object.values(t.blocks).map((b) => b.opcode)))];

test("Scratch.do emits an arbitrary original command with named inputs", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.do("looks_say", { MESSAGE: "raw hello" });
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(ops(result.sb3!).includes("looks_say"));
});

test("a raw block runs in real scratch-vm and produces the expected SAY", async () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.do("looks_say", { MESSAGE: "from raw" });
  const n = Scratch.get<number>("operator_add", { NUM1: 20, NUM2: 22 });
  Scratch.do("looks_say", { MESSAGE: "" + n });
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const session = await createStepSession(result.sb3!);
  try {
    session.greenFlag();
    for (let i = 0; i < 100 && session.activeThreads() > 0; i++) session.step();
    assert.deepEqual([...session.says].sort(), ["42", "from raw"]);
  } finally {
    session.close();
  }
});

test("Scratch.get emits an arbitrary reporter with named inputs", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  const n = Scratch.get<number>("operator_add", { NUM1: 2, NUM2: 3 });
  Scratch.say(n);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(ops(result.sb3!).includes("operator_add"));
});

test("Scratch.do carries static menu fields", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.do("motion_goto", {}, { TO: "_random_" });
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const blocks = project(result.sb3!).targets.flatMap((t) => Object.values(t.blocks));
  const goto = blocks.find((b) => b.opcode === "motion_goto");
  assert.deepEqual(goto?.fields?.TO, ["_random_", null]);
});

test("Scratch.do/get emit extension opcodes verbatim", () => {
  const result = compileSource(`
Scratch.onFlag(() => {
  Scratch.do("some_extension_command", { VALUE: 7 }, { MODE: "x" });
  const v = Scratch.get<number>("some_extension_reporter", {});
  Scratch.say(v);
});
`);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  const emitted = ops(result.sb3!);
  assert.ok(emitted.includes("some_extension_command"));
  assert.ok(emitted.includes("some_extension_reporter"));
});
