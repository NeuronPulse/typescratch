import { test } from "vitest";
import assert from "node:assert/strict";
import { castToBoolean, castToNumber, castToString } from "@typescratch/language";
import {
  allowedProfiles,
  CONVERSION_FIXTURES,
  isAbiProfile,
  objectRef,
  resolveProfile,
  runValueConformance,
  strictEquals,
  tag,
  tsToBoolean,
  tsToNumber,
  tsToString,
  untag,
  VALUE_PAIR_FIXTURES,
  VALUE_TAGS,
  type TaggedInput,
  type TaggedValue,
} from "@typescratch/runtime-abi";

test("tagged values round-trip without Scratch coercion", () => {
  const values: TaggedInput[] = [
    1, -0, Number.NaN, Infinity, -Infinity,
    "Hello", "", true, false, undefined, null, objectRef(12),
  ];
  for (const value of values) {
    const restored = untag(tag(value));
    if (typeof value === "object" && value !== null) {
      assert.deepEqual(restored, value);
    } else {
      assert.ok(Object.is(restored, value), `round trip changed ${String(value)}`);
    }
  }
});

test("every tag pair and conversion fixture conforms", () => {
  const report = runValueConformance();
  assert.deepEqual(report.mismatches, []);
  assert.equal(VALUE_TAGS.length, 6);
  assert.equal(
    VALUE_PAIR_FIXTURES.filter((fixture) => fixture.label.includes(" vs ")).length,
    36,
  );
  assert.equal(report.pairs, VALUE_PAIR_FIXTURES.length);
  assert.equal(report.conversions, CONVERSION_FIXTURES.length);
});

test("strict equality compares tags first and follows ECMAScript Number equality", () => {
  assert.equal(strictEquals(tag(1), tag("1")), false);
  assert.equal(strictEquals(tag(true), tag(1)), false);
  assert.equal(strictEquals(tag(Number.NaN), tag(Number.NaN)), false);
  assert.equal(strictEquals(tag(0), tag(-0)), true);
  assert.equal(strictEquals(tag("Hello"), tag("hello")), false);
  assert.equal(strictEquals(tag(undefined), tag(null)), false);
});

test("Value ABI conversions are ECMAScript, not Scratch Cast", () => {
  assert.equal(castToNumber("abc"), 0);
  assert.ok(Number.isNaN(tsToNumber(tag("abc"))));
  assert.equal(castToBoolean("false"), false);
  assert.equal(tsToBoolean(tag("false")), true);
  assert.equal(castToBoolean("0"), false);
  assert.equal(tsToBoolean(tag("0")), true);
  assert.equal(castToString(true), "true");
  assert.equal(tsToString(tag(true)), "true");
  assert.equal(tsToNumber(tag(null)), 0);
  assert.ok(Number.isNaN(tsToNumber(tag(undefined))));
});

test("unsupported primitives and unknown tags are rejected", () => {
  assert.throws(() => tag(BigInt(1) as unknown as TaggedInput), TypeError);
  assert.throws(() => untag(["x", 1] as unknown as TaggedValue), TypeError);
});

test("abi-profile capability rules keep target and profile orthogonal", () => {
  assert.deepEqual([...allowedProfiles("scratch")], ["native", "auto"]);
  assert.deepEqual([...allowedProfiles("turbowarp")], ["native", "extension", "auto"]);
  assert.equal(resolveProfile("auto", "scratch"), "native");
  assert.equal(resolveProfile("auto", "turbowarp"), "extension");
  assert.equal(resolveProfile("native", "turbowarp"), "native");
  assert.equal(isAbiProfile("native"), true);
  assert.equal(isAbiProfile("bogus"), false);
});
