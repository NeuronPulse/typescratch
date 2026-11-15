import { test } from "vitest";
import assert from "node:assert/strict";
import { NUMERIC_FIXTURES } from "@typescratch/testing";
import { strictEquals, tag } from "@typescratch/runtime-abi";

test("Value ABI strict equality agrees with the documented ECMAScript numeric profile", () => {
  let checked = 0;
  for (const fixture of NUMERIC_FIXTURES) {
    if (fixture.op !== "eq" && fixture.op !== "ne") continue;
    assert.equal(typeof fixture.javascript, "boolean", `${fixture.label} is not a boolean fixture`);
    const equal = strictEquals(tag(fixture.left), tag(fixture.right));
    const expected = fixture.op === "eq"
      ? fixture.javascript === true
      : fixture.javascript === false;
    assert.equal(equal, expected, `${fixture.label}: expected ${expected}, got ${equal}`);
    checked += 1;
  }
  assert.equal(checked, 10);
});
