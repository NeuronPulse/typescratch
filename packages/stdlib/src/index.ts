import { Scratch, type ArrayHandle } from "@typescratch/runtime";

/**
 * TypeScratch standard library. All routines are ordinary TypeScript source
 * compiled like user code — no compiler intrinsics.
 *
 * Scratch arrays need a compile-time size, so transforming routines write
 * into a caller-owned destination array instead of allocating dynamically.
 * Callers pass `Scratch.array<number>(capacity)` with a literal capacity.
 * Complexity is intentionally visible: O(n) scans and O(n^2) insertion sort.
 */

/** First index whose value equals target, or -1. */
export function linearSearch(values: ArrayHandle<number>, target: number): number {
  let i = 0;
  while (i < values.length()) {
    if (values.get(i) === target) return i;
    i = i + 1;
  }
  return -1;
}

/** Index of target in a sorted array, or -1. */
export function binarySearch(values: ArrayHandle<number>, target: number): number {
  let low = 0;
  let high = values.length() - 1;
  while (low <= high) {
    // No floor block: subtract the integer remainder to get an even sum.
    const pair = low + high;
    const mid = (pair - (pair % 2)) / 2;
    const value = values.get(mid);
    if (value === target) return mid;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

export function min(values: ArrayHandle<number>): number {
  if (values.length() === 0) return 0;
  let best = values.get(0);
  let i = 1;
  while (i < values.length()) {
    const v = values.get(i);
    if (v < best) best = v;
    i = i + 1;
  }
  return best;
}

export function max(values: ArrayHandle<number>): number {
  if (values.length() === 0) return 0;
  let best = values.get(0);
  let i = 1;
  while (i < values.length()) {
    const v = values.get(i);
    if (v > best) best = v;
    i = i + 1;
  }
  return best;
}

export function sum(values: ArrayHandle<number>): number {
  let total = 0;
  let i = 0;
  while (i < values.length()) {
    total = total + values.get(i);
    i = i + 1;
  }
  return total;
}

export function average(values: ArrayHandle<number>): number {
  if (values.length() === 0) return 0;
  return sum(values) / values.length();
}

export function count(values: ArrayHandle<number>, target: number): number {
  let found = 0;
  let i = 0;
  while (i < values.length()) {
    if (values.get(i) === target) found = found + 1;
    i = i + 1;
  }
  return found;
}

/** Fill dst with [start, start+1, ...]. Returns the number written. */
export function fillRange(dst: ArrayHandle<number>, start: number, length: number): number {
  let i = 0;
  while (i < length && i < dst.length()) {
    dst.set(i, start + i);
    i = i + 1;
  }
  return i;
}

/** Write the elements of values in reverse order into dst. */
export function reverse(values: ArrayHandle<number>, dst: ArrayHandle<number>): void {
  let i = 0;
  while (i < values.length() && i < dst.length()) {
    dst.set(i, values.get(values.length() - 1 - i));
    i = i + 1;
  }
}

/** Copy sorted input to dst, dropping adjacent duplicates. Returns new length. */
export function unique(values: ArrayHandle<number>, dst: ArrayHandle<number>): number {
  let write = 0;
  let i = 0;
  while (i < values.length() && write < dst.length()) {
    const v = values.get(i);
    if (i === 0 || v !== values.get(i - 1)) {
      dst.set(write, v);
      write = write + 1;
    }
    i = i + 1;
  }
  return write;
}

/**
 * Stable insertion sort by a comparator closure, writing into dst.
 * O(n^2); no quicksort until block cost is measured.
 */
export function sortBy(
  values: ArrayHandle<number>, less: (a: number, b: number) => boolean,
  dst: ArrayHandle<number>,
): void {
  let i = 0;
  while (i < values.length() && i < dst.length()) {
    dst.set(i, values.get(i));
    i = i + 1;
  }
  i = 1;
  while (i < values.length() && i < dst.length()) {
    const current = dst.get(i);
    let j = i;
    // The comparator is a closure call (a statement prelude in the IR), so it
    // must live in the body — a call in the while condition would be hoisted
    // and evaluated only once.
    let shifting = 1;
    while (j > 0 && shifting > 0) {
      if (less(current, dst.get(j - 1))) {
        dst.set(j, dst.get(j - 1));
        j = j - 1;
      } else {
        shifting = 0;
      }
    }
    dst.set(j, current);
    i = i + 1;
  }
}

export function sort(values: ArrayHandle<number>, dst: ArrayHandle<number>): void {
  const less = (a: number, b: number): boolean => a < b;
  sortBy(values, less, dst);
}

/**
 * Fisher-Yates shuffle in place. Uses the explicit Scratch random block;
 * this breaks frame-by-frame determinism and must not appear in golden traces.
 */
export function shuffle(values: ArrayHandle<number>): void {
  let i = values.length() - 1;
  while (i > 0) {
    const j = ScratchGetRandom(i);
    const tmp = values.get(i);
    values.set(i, values.get(j));
    values.set(j, tmp);
    i = i - 1;
  }
}

function ScratchGetRandom(upper: number): number {
  return Scratch.get<number>("operator_random", { FROM: 0, TO: upper });
}
