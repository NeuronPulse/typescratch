import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

/**
 * Spike A — Problem 2 layer 3 (epoch-based orphan frame reclamation).
 *
 * Question: can a TurboWarp-style extension worker learn about clone deletion
 * or script stop so it can advance an epoch and reclaim orphan frames?
 *
 * Observation: scratch-vm (host) emits targetWasRemoved / targetWasCreated /
 * PROJECT_STOP_ALL. The extension sandbox worker receives only `(args)` in its
 * handlers and has no VM reference. If the worker cannot observe the event,
 * epoch reclamation needs a NEW host hook and cannot be done in this ABI.
 */

interface VM {
  runtime: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    targets: unknown[];
    disposeTarget(target: unknown): void;
  };
  start(): void;
  loadProject(data: Uint8Array): Promise<void>;
}

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "Image", "HTMLCanvasElement", "XMLHttpRequest"]) {
    Object.defineProperty(g, key, { value: win[key], configurable: true, writable: true });
  }
  if (!g.navigator) Object.defineProperty(g, "navigator", { value: win.navigator, configurable: true });
}

async function loadVm(): Promise<VM> {
  installDom();
  const require = createRequire(import.meta.url);
  const exported = require("scratch-vm") as unknown;
  const VM = (typeof exported === "function" ? exported : (exported as { default: new () => VM }).default) as new () => VM;
  const vm = new VM();
  vm.start();
  await vm.loadProject(new Uint8Array(readFileSync("dist/hello.sb3")));
  return vm;
}

test("scratch-vm fires targetWasRemoved on the HOST runtime when a target is disposed", async () => {
  const vm = await loadVm();
  const events: string[] = [];
  for (const event of ["targetWasCreated", "targetWasRemoved", "PROJECT_STOP_ALL"]) {
    vm.runtime.on(event, () => events.push(event));
  }
  const target = vm.runtime.targets[0];
  assert.ok(target, "loaded project has a target");
  vm.runtime.disposeTarget(target);
  assert.ok(events.includes("targetWasRemoved"), `host saw targetWasRemoved; events=${JSON.stringify(events)}`);
});

test("extension handler/preamble has no access to VM lifecycle events", () => {
  const require = createRequire(import.meta.url);
  const abi = require("@typescratch/runtime-abi") as {
    frameExtensionPreamble: (limit?: number) => string;
    FRAME_EXTENSION_OPS: Record<string, { body(values: string[]): string[] }>;
  };
  const preamble = abi.frameExtensionPreamble();
  assert.match(preamble, /const frames = new Map\(\)/);
  assert.doesNotMatch(preamble, /\bvm\b|runtime\.on|targetWasRemoved|targetWasCreated|epoch/);
  const allBody = Object.values(abi.FRAME_EXTENSION_OPS)
    .flatMap((op) => op.body(["0", "1", "2", "3"])).join("\n");
  assert.doesNotMatch(allBody, /\bvm\b|targetWasRemoved|epoch/);
});

test("no owner/epoch concept exists in the frame ABI today", () => {
  const require = createRequire(import.meta.url);
  const { FRAME_EXTENSION_OPS } = require("@typescratch/runtime-abi") as {
    FRAME_EXTENSION_OPS: Record<string, { body(values: string[]): string[] }>;
  };
  const all = Object.values(FRAME_EXTENSION_OPS)
    .flatMap((op) => op.body(["0", "1", "2", "3"])).join("\n");
  assert.doesNotMatch(all, /ownerThreadId|\bepoch\b|threadId|cloneId/);
  assert.match(all, /freeIds\.push\(/);
});
