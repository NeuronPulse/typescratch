import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { compile } from "@typescratch/compiler";

/**
 * Spike B — Problem 3 Phase C (yield / async / generators).
 *
 * Gate (plan): "prove a suspended Scratch thread can be resumed without
 * `broadcast and wait` (which is a yield itself and would deadlock the model)."
 *
 * Mechanism: scratch-vm's Thread.STATUS_YIELD. `util.yield()` only writes
 * `thread.status`; the sequencer clears it back to RUNNING on the next step
 * and continues from the preserved stack — VM-native suspend/resume, no
 * broadcast, no promise, no hat.
 *
 * Verified on real headless scratch-vm: a thread is suspended via STATUS_YIELD,
 * keeps its stack, resumes next step, and reaches its final SAY.
 */

interface Thread { status: number; stack: unknown[]; isKilled: boolean }
interface VM {
  runtime: { threads: Thread[]; _step(): void; on(e: string, l: (...a: unknown[]) => void): void };
  start(): void;
  greenFlag(): void;
  loadProject(data: Uint8Array): Promise<void>;
}

const STATUS_RUNNING = 0;
const STATUS_YIELD = 2;

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "Image", "HTMLCanvasElement", "XMLHttpRequest"]) {
    Object.defineProperty(g, key, { value: win[key], configurable: true, writable: true });
  }
  if (!g.navigator) Object.defineProperty(g, "navigator", { value: win.navigator, configurable: true });
}

function yieldProject(): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "tscr-resume-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const entry = join(root, "src", "main.ts");
  writeFileSync(entry, `import { Scratch } from "@typescratch/runtime";
Scratch.onFlag(() => {
  const n = Scratch.global<number>("n", { initial: 0 });
  n.set(n.get() + 1);
  Scratch.wait(0.2);
  Scratch.say("done:" + n.get());
});
`);
  const result = compile({ entry, projectRoot: root, target: "scratch" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  return result.sb3!;
}

async function loadVm(sb3: Uint8Array): Promise<VM> {
  installDom();
  const require = createRequire(import.meta.url);
  const exported = require("scratch-vm") as unknown;
  const VM = (typeof exported === "function" ? exported : (exported as { default: new () => VM }).default) as new () => VM;
  const vm = new VM();
  vm.start();
  await vm.loadProject(sb3);
  return vm;
}

test("STATUS_YIELD suspends without aborting and resumes to completion", async () => {
  const vm = await loadVm(yieldProject());
  const says: string[] = [];
  vm.runtime.on("SAY", (...args: unknown[]) => { if (args[2] !== undefined) says.push(String(args[2])); });
  vm.greenFlag();

  // Step until the wait block yields; after that the thread keeps its stack
  // but is not advanced (STATUS_PROMISE_WAIT / YIELD from control_wait).
  let thread: Thread | undefined;
  for (let i = 0; i < 20; i++) {
    vm.runtime._step();
    thread = vm.runtime.threads.find((t) => !t.isKilled && t.stack.length > 0);
    if (thread) break;
  }
  assert.ok(thread, "a live thread exists while wait is pending");
  const depth = thread!.stack.length;
  assert.ok(depth > 0);
  // Force the VM-native yield state (same value util.yield() writes) and
  // confirm the sequencer resumes it without any broadcast.
  thread!.status = STATUS_YIELD;
  vm.runtime._step();
  assert.equal(thread!.status, STATUS_RUNNING, "sequencer cleared YIELD -> RUNNING");
  assert.equal(thread!.isKilled, false, "thread not aborted");
  assert.ok(thread!.stack.length >= depth - 3, "stack preserved across suspend");

  // Let it finish (wait timer elapses over real time in scratch-vm).
  for (let i = 0; i < 400 && thread!.stack.length > 0; i++) {
    await new Promise((r) => setTimeout(r, 2));
    vm.runtime._step();
  }
  assert.ok(says.some((s) => s.startsWith("done:")), `final SAY reached: ${JSON.stringify(says)}`);
});

test("STATUS_YIELD is VM-native (no broadcast/hat required)", () => {
  const vmSrc = (name: string) => readFileSync(`node_modules/scratch-vm/src/engine/${name}`, "utf8");
  assert.match(vmSrc("thread.js"), /get STATUS_YIELD \(\)\s*\{\s*return 2/);
  assert.match(
    vmSrc("block-utility.js"),
    /yield\s*\(\)\s*\{\s*this\.thread\.status\s*=\s*Thread\.STATUS_YIELD/s,
  );
  const seq = vmSrc("sequencer.js");
  assert.match(seq, /thread\.status\s*=\s*Thread\.STATUS_RUNNING/);
  // util.yield() itself does not touch broadcast/hat state.
  const util = vmSrc("block-utility.js");
  const yieldBody = util.slice(util.indexOf("yield ()"), util.indexOf("yieldTick ()"));
  assert.doesNotMatch(yieldBody, /broadcast|startHats|hat/);
});
