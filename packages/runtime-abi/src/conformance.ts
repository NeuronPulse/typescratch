import {
  objectRef,
  strictEquals,
  tag,
  tsToBoolean,
  tsToNumber,
  tsToString,
  VALUE_TAGS,
  type TaggedValue,
  type ValueTag,
} from "./value.ts";

export interface ValuePairFixture {
  label: string;
  left: TaggedValue;
  right: TaggedValue;
  expected: boolean;
}

export interface ConversionFixture {
  label: string;
  value: TaggedValue;
  number: number;
  string: string;
  boolean: boolean;
}

export interface ValueConformanceReport {
  pairs: number;
  conversions: number;
  mismatches: string[];
}

const representative: Record<ValueTag, TaggedValue> = {
  n: tag(1),
  s: tag("1"),
  b: tag(true),
  o: tag(objectRef(7)),
  u: tag(undefined),
  z: tag(null),
};

const crossTag: ValuePairFixture[] = [];
for (const leftTag of VALUE_TAGS) {
  for (const rightTag of VALUE_TAGS) {
    crossTag.push({
      label: `${leftTag} vs ${rightTag}`,
      left: representative[leftTag]!,
      right: representative[rightTag]!,
      expected: leftTag === rightTag,
    });
  }
}

const boundaries: ValuePairFixture[] = [
  { label: "NaN is never strictly equal to itself", left: tag(Number.NaN), right: tag(Number.NaN), expected: false },
  { label: "+0 === -0", left: tag(0), right: tag(-0), expected: true },
  { label: "Infinity === Infinity", left: tag(Infinity), right: tag(Infinity), expected: true },
  { label: "Infinity !== -Infinity", left: tag(Infinity), right: tag(-Infinity), expected: false },
  { label: "string equality is case sensitive", left: tag("Hello"), right: tag("hello"), expected: false },
  { label: "string 1 !== number 1", left: tag("1"), right: tag(1), expected: false },
  { label: "boolean true !== number 1", left: tag(true), right: tag(1), expected: false },
  { label: "boolean false !== empty string", left: tag(false), right: tag(""), expected: false },
  { label: "undefined !== null", left: tag(undefined), right: tag(null), expected: false },
  { label: "same object ref", left: tag(objectRef(3)), right: tag(objectRef(3)), expected: true },
  { label: "different object refs", left: tag(objectRef(3)), right: tag(objectRef(4)), expected: false },
];

export const VALUE_PAIR_FIXTURES: readonly ValuePairFixture[] = [...crossTag, ...boundaries];

export const CONVERSION_FIXTURES: readonly ConversionFixture[] = [
  { label: "number 1", value: tag(1), number: 1, string: "1", boolean: true },
  { label: "number 0", value: tag(0), number: 0, string: "0", boolean: false },
  { label: "negative zero", value: tag(-0), number: -0, string: "0", boolean: false },
  { label: "NaN", value: tag(Number.NaN), number: Number.NaN, string: "NaN", boolean: false },
  { label: "Infinity", value: tag(Infinity), number: Infinity, string: "Infinity", boolean: true },
  { label: "empty string", value: tag(""), number: 0, string: "", boolean: false },
  { label: "numeric string", value: tag("42"), number: 42, string: "42", boolean: true },
  { label: "non-numeric string", value: tag("abc"), number: Number.NaN, string: "abc", boolean: true },
  { label: "string false is truthy", value: tag("false"), number: Number.NaN, string: "false", boolean: true },
  { label: "whitespace string converts to zero", value: tag("  "), number: 0, string: "  ", boolean: true },
  { label: "hex string converts to a number", value: tag("0x10"), number: 16, string: "0x10", boolean: true },
  { label: "boolean true", value: tag(true), number: 1, string: "true", boolean: true },
  { label: "boolean false", value: tag(false), number: 0, string: "false", boolean: false },
  { label: "undefined", value: tag(undefined), number: Number.NaN, string: "undefined", boolean: false },
  { label: "null", value: tag(null), number: 0, string: "null", boolean: false },
  { label: "object ref", value: tag(objectRef(9)), number: Number.NaN, string: "[object Object]", boolean: true },
];

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right);
}

export function runValueConformance(): ValueConformanceReport {
  const mismatches: string[] = [];
  for (const fixture of VALUE_PAIR_FIXTURES) {
    const actual = strictEquals(fixture.left, fixture.right);
    if (actual !== fixture.expected) {
      mismatches.push(`${fixture.label}: expected ${fixture.expected}, got ${actual}`);
    }
  }
  for (const fixture of CONVERSION_FIXTURES) {
    const number = tsToNumber(fixture.value);
    const text = tsToString(fixture.value);
    const boolean = tsToBoolean(fixture.value);
    if (!sameNumber(number, fixture.number)) {
      mismatches.push(`${fixture.label}: tsToNumber expected ${String(fixture.number)}, got ${String(number)}`);
    }
    if (text !== fixture.string) {
      mismatches.push(`${fixture.label}: tsToString expected ${fixture.string}, got ${text}`);
    }
    if (boolean !== fixture.boolean) {
      mismatches.push(`${fixture.label}: tsToBoolean expected ${fixture.boolean}, got ${boolean}`);
    }
  }
  return {
    pairs: VALUE_PAIR_FIXTURES.length,
    conversions: CONVERSION_FIXTURES.length,
    mismatches,
  };
}
