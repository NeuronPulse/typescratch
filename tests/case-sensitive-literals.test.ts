import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { interpretModules } from "@typescratch/testing";

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-case-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

const SOURCE = `
import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => {
  Scratch.say("" + (("A" as unknown) == "a"));
  Scratch.say("" + (("a" as unknown) == "a"));
  Scratch.say("" + (("HELLO" as unknown) == "hello"));
  Scratch.say("" + (("Hello" as unknown) == "Hello"));
  Scratch.say("" + (("" as unknown) == ""));
  Scratch.say("" + (("AbC" as unknown) == "Abc"));
  Scratch.say("" + (("123" as unknown) == "123"));
  Scratch.say("" + (("a b" as unknown) == "a b"));
});
`;

test("string literal == uses case-sensitive ECMAScript semantics", () => {
  const result = compileSource(SOURCE);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(interpretModules(result.modules).says, [
    "false", "true", "false", "true", "true", "false", "true", "true",
  ]);
});
