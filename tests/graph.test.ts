import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticBag } from "@typescratch/diagnostics";
import { GraphBuilder, validateGraph } from "@typescratch/graph";

test("valid block chains pass graph validation", () => {
  const builder = new GraphBuilder();
  const hat = builder.add("event_whenflagclicked", { scope: "s", topLevel: true, x: 10, y: 20 });
  const say = builder.add("looks_say", { scope: "s" });
  builder.chain([hat, say]);
  builder.input(say, "MESSAGE", { primitive: [10, "hi"] });
  const bag = new DiagnosticBag();
  validateGraph(builder.project, bag);
  assert.deepEqual(bag.items, []);
  assert.equal(builder.find(say)?.parent, hat);
});

test("broken next/parent relationships are detected", () => {
  const builder = new GraphBuilder();
  const hat = builder.add("event_whenflagclicked", { scope: "s", topLevel: true });
  const say = builder.add("looks_say", { scope: "s" });
  builder.chain([hat, say]);
  const broken = builder.find(say);
  assert.ok(broken);
  broken.parent = null;
  const bag = new DiagnosticBag();
  validateGraph(builder.project, bag);
  assert.equal(bag.hasErrors, true);
});

test("block ids are deterministic", () => {
  const first = new GraphBuilder();
  const second = new GraphBuilder();
  const a = first.add("looks_say", { scope: "s" });
  const b = second.add("looks_say", { scope: "s" });
  assert.equal(a, b);
});
