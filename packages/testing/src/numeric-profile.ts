import type { BinOp } from "@typescratch/ir";
import { evalBinary, type TraceValue } from "./interpreter.ts";

export interface NumericFixture {
  label: string;
  op: BinOp;
  left: TraceValue;
  right: TraceValue;
  javascript: TraceValue;
  scratch: TraceValue;
}

export interface NumericDifference {
  label: string;
  javascript: TraceValue;
  scratch: TraceValue;
}

export interface NumericProfileReport {
  fixtures: number;
  differences: NumericDifference[];
  mismatches: string[];
}

export const NUMERIC_FIXTURES: NumericFixture[] = [
  { label: "number vs numeric string equality", op: "eq", left: 10, right: "10", javascript: false, scratch: true },
  { label: "number vs numeric string inequality", op: "ne", left: 10, right: "10", javascript: true, scratch: false },
  { label: "boolean vs number equality", op: "eq", left: true, right: 1, javascript: false, scratch: true },
  { label: "false vs zero equality", op: "eq", left: 0, right: false, javascript: false, scratch: true },
  { label: "non-numeric string vs zero equality", op: "eq", left: "abc", right: 0, javascript: false, scratch: false },
  { label: "empty string vs zero equality", op: "eq", left: "", right: 0, javascript: false, scratch: false },
  { label: "empty string less than zero", op: "lt", left: "", right: 0, javascript: false, scratch: true },
  { label: "non-numeric string greater than number", op: "gt", left: "abc", right: 10, javascript: false, scratch: true },
  { label: "negative dividend remainder", op: "mod", left: -5, right: 3, javascript: -2, scratch: 1 },
  { label: "negative divisor remainder", op: "mod", left: 5, right: -3, javascript: 2, scratch: -1 },
  { label: "modulo by zero", op: "mod", left: 7, right: 0, javascript: Number.NaN, scratch: Number.NaN },
  { label: "string plus number", op: "add", left: "3", right: 4, javascript: "34", scratch: 7 },
  { label: "non-numeric string plus number", op: "add", left: "abc", right: 2, javascript: "abc2", scratch: 2 },
  { label: "division by zero", op: "div", left: 1, right: 0, javascript: Infinity, scratch: Infinity },
  { label: "infinity equality", op: "eq", left: Infinity, right: Infinity, javascript: true, scratch: true },
  { label: "infinity text vs infinity", op: "eq", left: "Infinity", right: Infinity, javascript: false, scratch: true },
  { label: "NaN equality", op: "eq", left: Number.NaN, right: Number.NaN, javascript: false, scratch: true },
  { label: "numeric string less than number", op: "lt", left: "2", right: 10, javascript: true, scratch: true },
  { label: "case-insensitive text equality", op: "eq", left: "Hello", right: "hello", javascript: false, scratch: true },
];

function sameValue(left: TraceValue, right: TraceValue): boolean {
  if (typeof left === "number" && typeof right === "number") {
    if (Object.is(left, right)) return true;
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    return Math.abs(left - right) < 1e-9;
  }
  return typeof left === typeof right && left === right;
}

function show(value: TraceValue): string {
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function runNumericProfile(): NumericProfileReport {
  const mismatches: string[] = [];
  const differences: NumericDifference[] = [];
  for (const fixture of NUMERIC_FIXTURES) {
    const javascript = evalBinary(fixture.op, fixture.left, fixture.right, "javascript");
    const scratch = evalBinary(fixture.op, fixture.left, fixture.right, "scratch");
    if (!sameValue(javascript, fixture.javascript)) {
      mismatches.push(`${fixture.label} (javascript): expected ${show(fixture.javascript)}, got ${show(javascript)}`);
    }
    if (!sameValue(scratch, fixture.scratch)) {
      mismatches.push(`${fixture.label} (scratch): expected ${show(fixture.scratch)}, got ${show(scratch)}`);
    }
    if (!sameValue(javascript, scratch)) {
      differences.push({ label: fixture.label, javascript, scratch });
    }
  }
  return { fixtures: NUMERIC_FIXTURES.length, differences, mismatches };
}
