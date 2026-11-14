import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ExecutionTrace, TraceValue } from "./interpreter.ts";

type GlobalRecord = Record<string, unknown>;

export type HatTrigger =
  | { kind: "key"; key: string }
  | { kind: "spriteClicked" }
  | { kind: "clone" }
  | { kind: "backdrop"; name: string }
  | { kind: "broadcast"; name: string };

const TRIGGER_OPCODES: Record<HatTrigger["kind"], string> = {
  key: "event_whenkeypressed",
  spriteClicked: "event_whenthisspriteclicked",
  clone: "control_start_as_clone",
  backdrop: "event_whenbackdropswitchesto",
  broadcast: "event_whenbroadcastreceived",
};

function triggerFields(trigger: HatTrigger): Record<string, string> {
  switch (trigger.kind) {
    case "key": return { KEY_OPTION: trigger.key };
    case "backdrop": return { BACKDROP: trigger.name };
    case "broadcast": return { BROADCAST_OPTION: trigger.name };
    default: return {};
  }
}

interface VmThread {
  stack: unknown[];
}

interface VmVariable {
  name: string;
  value: unknown;
}

interface VmList {
  name: string;
  value: unknown[];
}

interface VmTarget {
  name?: string;
  getName?: () => string;
  variables: Record<string, VmVariable> | Map<string, VmVariable>;
  lists?: Record<string, VmList> | Map<string, VmList>;
}

interface VmRuntime {
  on(event: string, listener: (...args: unknown[]) => void): void;
  targets: VmTarget[];
  threads: VmThread[];
  startHats(opcode: string, fields?: Record<string, string>, target?: unknown): unknown[];
  stopAll(): void;
}

interface VmInstance {
  runtime: VmRuntime;
  start(): void;
  greenFlag(): void;
  loadProject(data: Uint8Array): Promise<void>;
}

export interface RunOptions {
  timeoutMs?: number;
  settleMs?: number;
  triggers?: HatTrigger[];
}

let installed = false;

function makeCanvasContext(canvas: unknown): unknown {
  const store: GlobalRecord = { canvas };
  return new Proxy(store, {
    get(target, key) {
      const name = String(key);
      if (name in target) return target[name];
      if (name === "measureText") {
        return (text: unknown) => ({
          width: String(text).length * 8,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
        });
      }
      if (name === "getImageData") {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      if (name === "createLinearGradient" || name === "createRadialGradient" || name === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      return () => undefined;
    },
    set(target, key, value) {
      target[String(key)] = value;
      return true;
    },
  });
}

class FakeImage {
  width = 1;
  height = 1;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  source = "";

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    queueMicrotask(() => this.onload?.());
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "load") this.onload = listener;
    if (type === "error") this.onerror = listener;
  }

  removeEventListener(): void {}
}

export function installDom(): void {
  if (installed) return;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as GlobalRecord;
  const globals = globalThis as unknown as GlobalRecord;
  const copied = [
    "window", "document", "navigator", "location", "HTMLElement", "HTMLCanvasElement",
    "HTMLImageElement", "Image", "DOMParser", "XMLSerializer", "Element", "Node", "Event",
    "CustomEvent", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame",
    "getComputedStyle", "devicePixelRatio", "self",
  ];
  for (const key of copied) {
    const value = win[key];
    if (value === undefined || globals[key] !== undefined) continue;
    globals[key] = typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(dom.window)
      : value;
  }
  globals.window = dom.window;
  globals.self = dom.window;

  const canvasProto = (win.HTMLCanvasElement as { prototype?: GlobalRecord } | undefined)?.prototype;
  if (canvasProto) {
    canvasProto.getContext = function (this: unknown) {
      return makeCanvasContext(this);
    };
    canvasProto.toDataURL = () => "data:image/png;base64,";
  }
  globals.Image = FakeImage;
  win.Image = FakeImage;
  installed = true;
}

function vmConstructor(exported: unknown): new () => VmInstance {
  if (typeof exported === "function") return exported as new () => VmInstance;
  if (exported && typeof exported === "object") {
    const candidate = (exported as { default?: unknown }).default;
    if (typeof candidate === "function") return candidate as new () => VmInstance;
  }
  throw new Error("scratch-vm did not export a VirtualMachine constructor");
}

function normalize(value: unknown): TraceValue {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, settleMs: number): Promise<void> {
  await new Promise((done) => setTimeout(done, settleMs));
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 16));
  }
}

export async function runSb3(sb3: Uint8Array, options: RunOptions = {}): Promise<ExecutionTrace> {
  installDom();
  const require = createRequire(import.meta.url);
  const VM = vmConstructor(require("scratch-vm") as unknown);
  const vm = new VM();
  const says: string[] = [];
  vm.runtime.on("SAY", (...args: unknown[]) => {
    const text = args[2];
    if (text !== undefined) says.push(String(text));
  });

  vm.start();
  const timeoutMs = options.timeoutMs ?? 5000;
  await withTimeout(vm.loadProject(Buffer.from(sb3)), timeoutMs, "scratch-vm loadProject");
  vm.greenFlag();
  for (const trigger of options.triggers ?? []) {
    vm.runtime.startHats(TRIGGER_OPCODES[trigger.kind], triggerFields(trigger));
  }
  await waitUntil(
    () => (vm.runtime.threads ?? []).every((thread) => thread.stack.length === 0),
    timeoutMs,
    options.settleMs ?? 80,
  );

  const variables: Record<string, TraceValue> = {};
  const lists: Record<string, TraceValue[]> = {};
  for (const target of vm.runtime.targets ?? []) {
    const name = target.getName?.() ?? target.name ?? "Sprite1";
    const rawVariables = target.variables;
    const variableEntries = rawVariables instanceof Map ? [...rawVariables.values()] : Object.values(rawVariables ?? {});
    for (const variable of variableEntries) {
      variables[`${name}:${variable.name}`] = normalize(variable.value);
    }
    const rawLists = target.lists;
    const listEntries = rawLists instanceof Map ? [...rawLists.values()] : Object.values(rawLists ?? {});
    for (const list of listEntries) {
      lists[`${name}:${list.name}`] = (list.value ?? []).map(normalize);
    }
  }
  vm.runtime.stopAll();
  return { says, commands: [], variables, lists, steps: 0 };
}
