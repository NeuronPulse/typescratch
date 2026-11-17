import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder, type BlockId } from "@typescratch/graph";
import { exportSb3 } from "@typescratch/exporter-sb3";

const ID = "tscr0c0570ab01";
const OPS = ["frameAlloc", "frameSet", "frameGet", "frameFree", "nested", "recursive"] as const;
const OUT = "costOut";

function extensionCode(): string {
  const blocks = OPS.map((op) => ({
    opcode: op,
    blockType: "reporter",
    text: `${op} [A]`,
    arguments: { A: { type: "STRING" } },
  }));
  return `(function (Scratch) {
  'use strict';
  const stats = { counts: {}, totalMs: 0, log: [] };
  window.__tscrCostStats = stats;
  function record(name, start) {
    stats.counts[name] = (stats.counts[name] || 0) + 1;
    const ms = performance.now() - start;
    stats.totalMs += ms;
    stats.log.push({ name, ms });
    console.log("TSCR_COST " + JSON.stringify({ counts: stats.counts, totalMs: stats.totalMs, log: stats.log }));
  }
  const handlers = {
    ${OPS.map((op) => `${op}: function(args) { const t = performance.now(); record('${op}', t); return '${op}:' + args.A; }`).join(",\n    ")}
  };
  class Probe {
    getInfo() { return { id: '${ID}', name: 'Cost probe', blocks: ${JSON.stringify(blocks)} }; }
    ${OPS.map((op) => `${op}(args) { return handlers['${op}'](args); }`).join("\n    ")}
  }
  Scratch.extensions.register(new Probe());
})(Scratch);`;
}

function build(): Uint8Array {
  const builder = new GraphBuilder([{ name: "Stage", isStage: true }, { name: "Sprite1", isStage: false }]);
  builder.declareList(OUT, OUT, []);
  builder.project.extensions = [ID];
  builder.project.extensionURLs = {
    [ID]: `data:application/javascript;base64,${Buffer.from(extensionCode(), "utf8").toString("base64")}`,
  };
  const scope = "cost-probe";
  const chain: BlockId[] = [builder.add("event_whenflagclicked", { scope, topLevel: true })];
  for (const op of OPS) {
    const reporter = builder.add(`${ID}_${op}`, { scope });
    builder.input(reporter, "A", { primitive: [4, "x"] });
    const add = builder.add("data_addtolist", { scope, fields: { LIST: [OUT, OUT] } });
    builder.input(add, "ITEM", { block: reporter });
    chain.push(add);
  }
  builder.chain(chain);
  const bag = new DiagnosticBag();
  const sb3 = exportSb3(builder.project, bag);
  assert.deepEqual(bag.items, [], JSON.stringify(bag.items));
  return sb3;
}

test("write frame cost probe sb3 for browser measurement", () => {
  writeFileSync("dist/frame-cost-probe.sb3", build());
  console.log("Run: pnpm exec playwright-cli open 'https://turbowarp.org/editor/?project_url=data:...' then authorize, green-flag and read TSCR_COST logs.");
});
