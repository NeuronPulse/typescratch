# Native-only standard library (2026-11-20)

Scope: JS-standard-looking APIs that map to **Scratch native blocks only** —
no extension handler, no worker, no TurboWarp dependency. `runtime.d.ts`
declares everything; the compiler resolves by symbol, so aliasing works.

## Supported

| JS | Native block | Notes |
| --- | --- | --- |
| `Math.PI`, `Math.E` | compile-time constants | folded, zero blocks |
| `Math.abs` | `operator_mathop abs` | |
| `Math.floor` / `Math.ceil` / `Math.round` | `operator_mathop` / `operator_round` | |
| `Math.sqrt` | `operator_mathop sqrt` | |
| `Math.log` | `operator_mathop ln` | JS `Math.log` = natural log |
| `Math.log10` | `operator_mathop log` | Scratch's `log` is base 10 |
| `Math.exp` | `operator_mathop e ^` | |
| `Math.sin/cos/tan` | `operator_mathop` | input multiplied by `180/π`: Scratch uses degrees, JS radians |
| `Math.asin/acos/atan` | `operator_mathop` | output multiplied by `π/180` for the same reason |
| `string.charAt(i)` | `operator_letter_of` | index +1: Scratch is 1-based |
| `string.includes(s)` | `operator_contains` | boolean reporter |
| `string.length` | `operator_length` | |
| `string.toUpperCase()/toLowerCase()` | extension reporter | **not native** — Scratch has no case block; listed here only because the API already exists |

## Deliberately absent

`Math.pow`, `min`, `max`, `sign`, `trunc`, `hypot`, `cbrt`, `log2`, `random` (the 0–1 JS form), `String.indexOf`, `lastIndexOf`, `slice`, `substring`, `split`, `repeat`, `padStart`, `trim`, `Number.parseInt`, `parseFloat`, `isNaN`, `isFinite`.

Reasons, in increasing order of annoyance:

- No native block: `pow`, `hypot`, `cbrt`, `log2`, `trim`, `split`, `repeat`.
- Needs a conditional expression the IR does not have: `min`/`max`/`sign`/`trunc`.
- Needs a loop: `indexOf`, `lastIndexOf`, `slice`, `substring`, `repeat`.
- Semantics disagree with Scratch `Cast` too badly to pretend: `parseInt`/`parseFloat`/`isNaN`. Scratch turns `NaN` into `0` in variables, which is why the frontend rejects `NaN`/`Infinity` identifiers outright.
- `Math.random()` scrambles the every-frame deterministic model; use the deterministic `Math.random(from,to)` block via `Scratch.get<number>("operator_random", {FROM, TO})` if you really want nondeterminism.

Using any of these gets a `TSCR1001`/`TSCR2001` diagnostic from the TypeScript frontend or the language-subset check — never a silent wrong answer.

## Literal handling

Supported: decimal/hex/binary/octal numbers, numeric separators, exponent
notation (TS's scanner normalises them), strings, template strings with
interpolation, booleans, negative numbers. Compile-time literal folding uses
the same values the runtime would see.

Rejected with targeted diagnostics:

- `null` / `undefined` — no Scratch representation; use `-1` or `""`.
- Array/object literals — use `Scratch.array<T>(size)` or a class instance.
- Non-finite numeric literals (`1e400`) and the `NaN`/`Infinity` identifiers —
  Scratch casts `NaN` to `0` and does not preserve `Infinity` in variables.
- Negative literal `%` (`TSCR4005`) — JS remainder and Scratch `mod` disagree.

## Verification

`tests/stdlib.test.ts`, 5/5 on real headless scratch-vm:

- `Math.PI`/`E` constants compile and fold.
- `sin(π/2) → 1`, `cos(π) → -1`, `asin(1) → π/2` (radians, not degrees).
- abs/floor/ceil/round/log10/exp produce the expected numbers.
- charAt/includes/length produce `e`, `true`, `5`.
- null/undefined/array/overflow literals get the targeted diagnostics.

`pnpm verify` 6/6, golden unchanged.
