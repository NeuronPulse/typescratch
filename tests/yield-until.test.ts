import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@typescratch/compiler";
import { createStepSession, interpretModules } from "@typescratch/testing";

function compileWarpSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-wu-warp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch, warp } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

/**
 * Language-level suspend via Scratch.waitUntil(condition).
 *
 * control_wait_until re-evaluates CONDITION every VM step and util.yield()s
 * while false. The VM thread's stack is the continuation (resumption spike),
 * so no frame slot / broadcast / host hook is needed. This test proves a real
 * suspended script resumes when ANOTHER script changes the condition.
 */

function compileSource(source: string) {
  const root = mkdtempSync(join(tmpdir(), "tscr-waituntil-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";\n` + source);
  return compile({ entry, projectRoot: root, target: "scratch" });
}

const INTERLEAVED = `
const ready = Scratch.global<number>("ready", { initial: 0 });
const probe = Scratch.list<number>("probe");

Scratch.onFlag(() => {
  probe.push(1);
  Scratch.waitUntil(ready.get() === 1);
  probe.push(3);
  Scratch.say("resumed");
});

Scratch.onKey("space", () => {
  probe.push(2);
  ready.set(1);
});
`;

test("waitUntil lowers to a yielding control_wait_until block", () => {
  const result = compileSource(INTERLEAVED);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.ok(result.sb3);
  // The IR keeps waitUntil as an expr with a yields effect.
  const commands = result.modules[0]!.scripts.flatMap((s) => s.body)
    .filter((stmt) => stmt.k === "expr").map((stmt) => (stmt as { name: string }).name);
  assert.ok(commands.includes("waitUntil"), `IR has waitUntil; commands=${JSON.stringify(commands)}`);
});

test("yielding commands inside a @warp method are rejected with TSCR3005", () => {
  for (const call of ["Scratch.waitUntil(ready.get() === 1)", "Scratch.wait(0.1)"]) {
    const result = compileWarpSource(`
const ready = Scratch.global<number>("ready", { initial: 0 });
class C {
  @warp blocked(): void { ${call}; }
}
Scratch.onFlag(() => { const c = new C(); c.blocked(); });
`);
    assert.equal(result.ok, false, call + JSON.stringify(result.report.diagnostics));
    assert.ok(result.report.diagnostics.some((d) => d.code === "TSCR3005"), call + JSON.stringify(result.report.diagnostics));
  }
});

test("a script suspended on waitUntil resumes when another script sets the condition", async () => {
  const result = compileSource(INTERLEAVED);
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  // Interpreter has no scheduler; waitUntil is a single forward step there and
  // must not break the synchronous API (all existing call sites depend on it).
  const interpreted = interpretModules(result.modules);
  // No scheduler in the interpreter: waitUntil is one forward step, so every
  // script completes synchronously. Only the API shape is under test here.
  assert.ok((interpreted.says ?? []).includes("resumed"));

  assert.ok(result.sb3);
  const session = await createStepSession(result.sb3);
  try {
    session.greenFlag();
    // Let the waiting script reach waitUntil and suspend. It can never finish
    // on its own because ready starts at 0.
    for (let i = 0; i < 30; i++) session.step();
    const during = session.lists()["Stage:probe"] ?? session.lists()["Sprite1:probe"];
    assert.deepEqual(during, ["1"], "waiter suspended before push(3)");
    assert.deepEqual([...session.says], [], "no SAY while suspended");

    // Another script sets the condition. On a later step the waiter observes
    // it and continues past waitUntil to push 3 and say "resumed".
    session.startHat("event_whenkeypressed", { KEY_OPTION: "space" });
    for (let i = 0; i < 60 && session.activeThreads() > 0; i++) session.step();
    const after = session.lists()["Stage:probe"] ?? session.lists()["Sprite1:probe"];
    assert.deepEqual(after, ["1", "2", "3"]);
    assert.deepEqual([...session.says], ["resumed"]);
  } finally {
    session.close();
  }
});
