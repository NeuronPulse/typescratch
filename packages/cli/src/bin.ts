#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compile, formatReport } from "@typescratch/compiler";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    entry: { type: "string" },
    config: { type: "string" },
    target: { type: "string" },
    out: { type: "string" },
    "abi-profile": { type: "string" },
    explain: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("usage:");
  console.log("  typescratch init [path]                     scaffold the default Sprite1 workspace");
  console.log("  typescratch <build|check|explain> [--entry <file> | --config <tscr.config.json>] [--target <scratch|turbowarp>] [--abi-profile <native|extension|auto>] [--out <file>]");
  process.exit(0);
}

const command = positionals[0] ?? "build";
if (command === "init") {
  const destination = resolve(process.cwd(), positionals[1] ?? "my-project");
  if (existsSync(destination)) {
    console.error(`destination already exists: ${destination}`);
    process.exit(1);
  }
  const template = fileURLToPath(new URL("../../workspace/template", import.meta.url));
  cpSync(template, destination, { recursive: true });
  console.log(`created default workspace at ${destination}`);
  process.exit(0);
}
if (command !== "build" && command !== "check" && command !== "explain") {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}

const target = values.target as "scratch" | "turbowarp" | undefined;
if (target && target !== "scratch" && target !== "turbowarp") {
  console.error(`unknown target: ${target}`);
  process.exit(1);
}

const abiProfile = values["abi-profile"] as string | undefined;
if (abiProfile && abiProfile !== "native" && abiProfile !== "extension" && abiProfile !== "auto") {
  console.error(`unknown abi-profile: ${abiProfile}`);
  process.exit(1);
}

const projectRoot = process.cwd();
const out = values.out ?? "dist/project.sb3";
const explain = command === "explain" || values.explain === true;

const result = compile({
  entry: values.entry,
  configPath: values.config,
  projectRoot,
  target,
  abiProfile,
  explain,
  outputName: basename(out),
});
if (command !== "check" && result.ok && result.outputs.length > 0) {
  const outputDir = dirname(resolve(projectRoot, out));
  mkdirSync(outputDir, { recursive: true });
  for (const file of result.outputs) {
    const destination = resolve(outputDir, file.filename);
    mkdirSync(dirname(destination), { recursive: true });
    if (typeof file.contents === "string") writeFileSync(destination, file.contents);
    else writeFileSync(destination, file.contents);
  }
}
console.log(formatReport(result.report, explain));
process.exitCode = result.ok ? 0 : 1;
