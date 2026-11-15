import { compile } from "@typescratch/compiler";
import { compareTraces, interpretModules, runSb3, type HatTrigger } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";
import { EVENT_TRIGGERS } from "./events.ts";

interface ConformanceCase {
  label: string;
  entry?: string;
  configPath?: string;
  unorderedSays?: boolean;
  triggers?: HatTrigger[];
  ignoreCompilerState?: boolean;
}

function quiet(original: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const text = args.map((value) => String(value)).join(" ");
    if (text.includes("No storage module present")) return;
    if (text.includes("Central dispatch replacing existing service provider")) return;
    original(...args);
  };
}
console.warn = quiet(console.warn.bind(console));
console.error = quiet(console.error.bind(console));
console.log = quiet(console.log.bind(console));

const cases: ConformanceCase[] = [
  { label: "hello-native", entry: example("hello-native") },
  { label: "calc", entry: example("calc") },
  { label: "logical", entry: example("logical") },
  { label: "constant", entry: example("constant") },
  { label: "alias", entry: example("alias") },
  { label: "two-hats", entry: example("two-hats"), unorderedSays: true },
  { label: "list", entry: example("list") },
  { label: "ir-opt", entry: example("ir-opt") },
  { label: "break-continue", entry: example("break-continue") },
  {
    label: "events",
    entry: example("events"),
    unorderedSays: true,
    triggers: EVENT_TRIGGERS,
  },
  {
    label: "workspace",
    configPath: "examples/workspace/tscr.config.json",
    unorderedSays: true,
  },
  {
    label: "default-workspace",
    configPath: "packages/workspace/template/tscr.config.json",
  },
  { label: "edge-hat", entry: example("edge-hat") },
  { label: "memory-object", entry: example("memory-object"), ignoreCompilerState: true },
  { label: "memory-classes", entry: example("memory-classes"), ignoreCompilerState: true },
  { label: "function-return", entry: example("function-return"), ignoreCompilerState: true },
  { label: "function-nested", entry: example("function-nested"), ignoreCompilerState: true },
  { label: "function-boolean", entry: example("function-boolean"), ignoreCompilerState: true },
  { label: "function-recursion", entry: example("function-recursion"), ignoreCompilerState: true },
  {
    label: "function-reentrant",
    entry: example("function-reentrant"),
    unorderedSays: true,
    triggers: [{ kind: "key", key: "space" }],
    ignoreCompilerState: true,
  },
];

const watchdog = setTimeout(() => {
  console.error("VM conformance timed out after 90s");
  process.exit(1);
}, 90_000);

let failures = 0;
for (const item of cases) {
  try {
    const result = compile({
      entry: item.entry,
      configPath: item.configPath,
      projectRoot: ROOT,
      target: "scratch",
    });
    if (!result.ok || !result.sb3) {
      console.error(`VM conformance ${item.label}: compile failed`, result.report.diagnostics);
      failures += 1;
      continue;
    }
    const expected = interpretModules(result.modules);
    const actual = await runSb3(result.sb3, { timeoutMs: 8000, triggers: item.triggers });
    const diffs = compareTraces(expected, actual, {
      ignoreExtraVariables: true,
      ignoreCompilerState: item.ignoreCompilerState,
      unorderedSays: item.unorderedSays,
    });
    if (diffs.length > 0) {
      console.error(`VM conformance ${item.label}: ${diffs.length} mismatch(es)`);
      for (const diff of diffs) console.error(`  ${diff}`);
      failures += 1;
      continue;
    }
    console.log(
      `VM conformance ok: ${item.label} (${expected.says.length} says, ${Object.keys(expected.variables).length} variables, ${Object.keys(expected.lists).length} lists)`,
    );
  } catch (error) {
    console.error(`VM conformance ${item.label}: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  }
}

clearTimeout(watchdog);
if (failures > 0) console.error(`VM conformance failed: ${failures}/${cases.length} cases`);
else console.log(`VM conformance passed: ${cases.length}/${cases.length} cases ran in headless scratch-vm`);
process.exit(failures > 0 ? 1 : 0);
