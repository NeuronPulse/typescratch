import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface VmInstance {
  runtime: { on(event: string, listener: (...args: unknown[]) => void): void };
  start(): void;
  greenFlag(): void;
  loadProject(data: Uint8Array): Promise<void>;
}

if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  console.log("VM smoke skipped: headless scratch-vm needs a browser DOM; verify the .sb3 in the Scratch/TurboWarp editor.");
  process.exit(0);
}

const watchdog = setTimeout(() => {
  console.error("VM smoke timed out after 5s");
  process.exit(1);
}, 5000);

const name = "scratch" + "-vm";
const module = (await import(name)) as { default: new () => VmInstance };
const VM = module.default;

const project = readFileSync(resolve(process.cwd(), "dist/hello.sb3"));
const vm = new VM();
const says: string[] = [];
vm.runtime.on("SAY", (_target: unknown, _type: unknown, text: unknown) => {
  says.push(String(text));
});

try {
  vm.start();
  await vm.loadProject(project);
  vm.greenFlag();
  await new Promise((done) => setTimeout(done, 500));
  if (!says.includes("Hello from TypeScratch!")) {
    console.error("VM smoke failed: expected SAY event was not observed", says);
    process.exitCode = 1;
  } else {
    console.log("VM smoke ok: green flag produced the expected SAY event");
  }
} catch (error) {
  console.error("VM smoke failed (headless DOM/runtime requirement):", error);
  process.exitCode = 1;
}

clearTimeout(watchdog);
process.exit(process.exitCode ?? 0);
