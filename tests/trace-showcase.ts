import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "@typescratch/compiler";
import { formatTrace, recordTrace } from "@typescratch/testing";
import { example, ROOT } from "./helpers.ts";

const result = compile({ entry: example("showcase"), projectRoot: ROOT, target: "scratch" });
if (!result.ok || !result.sb3) {
  throw new Error(`showcase failed to compile: ${JSON.stringify(result.report.diagnostics)}`);
}
const trace = await recordTrace(result.sb3, { greenFlags: 3 });
const text = formatTrace(trace);
const destination = resolve(ROOT, "dist/showcase.trace.txt");
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${text}\n`);
console.log(text);
console.log(`wrote ${destination}`);
process.exit(0);
