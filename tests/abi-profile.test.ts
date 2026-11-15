import { test } from "vitest";
import assert from "node:assert/strict";
import { compile } from "@typescratch/compiler";
import { isProfileImplemented } from "@typescratch/runtime-abi";
import { example, ROOT } from "./helpers.ts";

function build(options: { target?: "scratch" | "turbowarp"; abiProfile?: string }) {
  return compile({
    entry: example("hello-native"),
    projectRoot: ROOT,
    ...options,
  });
}

const AUTO_STATIC = {
  requested: "auto",
  resolved: "native",
  lowering: "native",
  reason: "auto: cheapest capable profile for [no ABI contracts]",
};

test("auto picks the cheapest capable profile, not a target hardcode", () => {
  const scratch = build({ target: "scratch" });
  assert.equal(scratch.ok, true, JSON.stringify(scratch.report.diagnostics));
  assert.deepEqual(scratch.report.abiProfile, AUTO_STATIC);

  const turbowarp = build({ target: "turbowarp" });
  assert.equal(turbowarp.ok, true, JSON.stringify(turbowarp.report.diagnostics));
  assert.deepEqual(turbowarp.report.abiProfile, AUTO_STATIC);
  assert.equal(turbowarp.report.abiProfile.resolved, turbowarp.report.abiProfile.lowering);
});

test("auto stays on native when contracts are required but extension implements none", () => {
  const result = compile({ entry: example("showcase"), projectRoot: ROOT, target: "turbowarp" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.equal(result.report.abiProfile.resolved, "native");
  assert.equal(result.report.abiProfile.lowering, "native");
  assert.match(result.report.abiProfile.reason, /cheapest capable profile for \[value, call, frame/);
});

test("the scratch target rejects the extension abi profile with TSCR5001", () => {
  const result = build({ target: "scratch", abiProfile: "extension" });
  assert.equal(result.ok, false);
  assert.ok(
    result.report.diagnostics.some((item) => item.code === "TSCR5001" && item.message.includes("abi-profile")),
    JSON.stringify(result.report.diagnostics),
  );
  assert.deepEqual(result.report.abiProfile, {
    requested: "extension",
    resolved: "extension",
    lowering: "native",
    reason: "explicit --abi-profile extension",
  });
});

test("an explicit extension profile is rejected instead of silently lowering to native", () => {
  const result = build({ target: "turbowarp", abiProfile: "extension" });
  assert.equal(result.ok, false);
  assert.ok(
    result.report.diagnostics.some((item) => item.code === "TSCR5001" && item.message.includes("not implemented")),
    JSON.stringify(result.report.diagnostics),
  );
  assert.equal(isProfileImplemented("extension"), false);
  assert.equal(isProfileImplemented("auto"), true);
  assert.equal(isProfileImplemented("native"), true);
});

test("an explicit native profile is honoured on turbowarp", () => {
  const result = build({ target: "turbowarp", abiProfile: "native" });
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
  assert.deepEqual(result.report.abiProfile, {
    requested: "native",
    resolved: "native",
    lowering: "native",
    reason: "explicit --abi-profile native",
  });
});

test("an unknown abi profile is rejected with TSCR5001", () => {
  const result = build({ abiProfile: "bogus" });
  assert.equal(result.ok, false);
  assert.ok(result.report.diagnostics.some((item) => item.code === "TSCR5001"));
  assert.deepEqual(result.report.abiProfile, AUTO_STATIC);
});
