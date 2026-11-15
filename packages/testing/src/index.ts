import { castToString } from "@typescratch/language";
import type { ExecutionTrace, TraceValue } from "./interpreter.ts";

export * from "./interpreter.ts";
export * from "./numeric-profile.ts";
export * from "./vm.ts";

export interface CompareOptions {
  ignoreExtraVariables?: boolean;
  ignoreCompilerState?: boolean;
  tolerance?: number;
  unorderedSays?: boolean;
}

function show(value: TraceValue | undefined): string {
  if (value === undefined) return "<missing>";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return `${typeof value}:${JSON.stringify(value)}`;
}

function valuesEqual(left: TraceValue | undefined, right: TraceValue | undefined, tolerance: number): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= tolerance;
  if (typeof left === "boolean" || typeof right === "boolean") return false;
  return castToString(left) === castToString(right);
}

export function compareTraces(
  expected: ExecutionTrace,
  actual: ExecutionTrace,
  options: CompareOptions = {},
): string[] {
  const diffs: string[] = [];
  const tolerance = options.tolerance ?? 1e-9;
  const hidden = (key: string): boolean => options.ignoreCompilerState === true
    && (key.includes(":abi.") || key.includes(":_tscr_"));
  const wantSays = options.unorderedSays ? [...expected.says].sort() : expected.says;
  const gotSays = options.unorderedSays ? [...actual.says].sort() : actual.says;
  const count = Math.max(wantSays.length, gotSays.length);
  for (let index = 0; index < count; index++) {
    const want = wantSays[index];
    const got = gotSays[index];
    if (want !== got) {
      const label = options.unorderedSays ? `say (unordered)[${index}]` : `say[${index}]`;
      diffs.push(`${label}: expected ${show(want)}, got ${show(got)}`);
    }
  }
  const keys = new Set([
    ...Object.keys(expected.variables),
    ...(options.ignoreExtraVariables ? [] : Object.keys(actual.variables)),
  ]);
  for (const key of [...keys].sort()) {
    if (hidden(key)) continue;
    const want = expected.variables[key];
    const got = actual.variables[key];
    if (!valuesEqual(want, got, tolerance)) {
      diffs.push(`variable ${key}: expected ${show(want)}, got ${show(got)}`);
    }
  }
  const listKeys = new Set([
    ...Object.keys(expected.lists ?? {}),
    ...(options.ignoreExtraVariables ? [] : Object.keys(actual.lists ?? {})),
  ]);
  for (const key of [...listKeys].sort()) {
    if (hidden(key)) continue;
    const want = expected.lists?.[key] ?? [];
    const got = actual.lists?.[key] ?? [];
    const size = Math.max(want.length, got.length);
    for (let index = 0; index < size; index++) {
      if (!valuesEqual(want[index], got[index], tolerance)) {
        diffs.push(`list ${key}[${index}]: expected ${show(want[index])}, got ${show(got[index])}`);
      }
    }
  }
  return diffs;
}
