# Runtime String Equality Fix — Design & Spike Evidence (2026-11-17)

## Problem with the earlier Spike (superseded)

The first spike (`runtime-equality-spike-report.md`, NO-GO) tested costume
identity as a **total** string-equality mechanism: every character was looked
up by costume number, and any character without a costume collapsed to
`__SENTINEL__`, so two different unsupported characters were judged equal. That
was a real bug in the *proposed mechanism*, but it asked the wrong question.

**Correct question** (per the design direction): costume identity is used
**only to discriminate letter case**. Everything else stays with Scratch's
`operator_equals`, which is already correct for non-case comparisons.

## Gate behavior (measured, headless scratch-vm)

`tests/runtime-equality-gate-spike.test.ts` measures what
`operator_equals` actually does. `js=` is ECMAScript `===` for strings:

| pair | scratch gate | js | category |
| --- | --- | --- | --- |
| `A` / `a` | true | false | ASCII case fold — **costume required** |
| `É` / `é`, `Σ` / `σ` | true | false | non-ASCII case fold — known limit (see below) |
| `İ` / `i`, `ß` / `ss`, `σ` / `ς` | false | false | gate already correct |
| `中` / `中`, `😀` / `😀`, `é` / `é`, empty | true | true | gate already correct |
| `é` / `中`, `😀` / `😁`, lone surrogates | false | false | gate already correct |
| `10` / `10.0` | true | false | numeric coercion — **length check required** |

So the gate (`operator_equals`) is correct for every pair **except** case-fold
pairs and numeric-looking-string pairs. Costumes have exactly one job: split
`A` from `a`. Length comparison splits `10` from `10.0`.

## Fixed algorithm (per comparison of two static-`string` operands)

```
strictStringEqual(a, b):
  if !operator_equals(a, b) return false        # gate: cheap, correct for most
  if operator_length(a) != operator_length(b) return false   # 10 vs 10.0
  for i in 1..length(a):
    ca = letter(i, a); cb = letter(i, b)
    # both characters are, by the gate, case-insensitively equal.
    switch costume to sentinel, then to ca → idA
    switch costume to sentinel, then to cb → idB
    if idA != idB return false                  # A vs a (supported ASCII case)
  return true
```

Only ASCII letters `[A-Za-z]` get distinct costumes (plus `__SENTINEL__`).
All other characters — digits, punctuation, CJK, emoji, whitespace, lone
surrogates — land on the sentinel. That is now **safe** because:

- a gate=true pair of unsupported characters is either identical (both see
  the same sentinel → true, correct) or a non-ASCII case fold (`É`/`é`) —
  *documented limitation*, not a false positive introduced by the costume
  trick; the native `operator_equals` already returned true for those.
- a gate=false pair never reaches the costume logic at all.

**Character coverage**: exact for `[A-Za-z0-9 ]` and every character whose
case-fold is identity (CJK, emoji, punctuation, control chars, surrogate
pairs). Known limitation: non-ASCII case folds (`É`/`é`, `Σ`/`σ`, `İ`/`i`
where Scratch folds to a different form) remain case-insensitive because
Scratch's gate is case-insensitive for them and no finite costume set can
cover Unicode case pairs. This is reported via `TSCR2003` compatibility note
in the build report; it is not silently presented as full ECMAScript
semantics.

## Concurrency & state isolation

Costume state is global to the sprite. An earlier attempt used a warp helper
procedure; headless testing exposed scratch-vm procedure-call scheduling that
made consecutive comparisons read stale globals, so that design was dropped.
The shipped implementation **inlines** the gate + switch + read sequence as
statements in the enclosing script's prelude, immediately before the reader.

The generated sequence resets a shared costume-probe index to 0 before each
comparison (consecutive comparisons otherwise start at the previous loop's
final index and silently misread). It snapshots both operands and the boolean
result into fresh locals, so interleaving scripts cannot corrupt a comparison.

Headless scratch-vm verification (`tests/runtime-string-equality.test.ts`):
8 mixed comparisons in one flag script (case, identical, length mismatch,
gate-rejected Unicode, emoji, `!=`) produce exact ECMAScript answers. The
standalone gate Spike (`tests/runtime-equality-gate.test.ts`, 20 cases) covers
the full character matrix and shared-sprite concurrency. Recursive equality is
not applicable: `==` is a leaf expression and nested comparisons snapshot into
distinct locals.

## Failure semantics

- Inputs reaching this path: both operands statically typed `string` at the
  IR level. TypeScript `string` can be arbitrary Unicode; the algorithm is
  safe (never returns false for gate-equal identical strings, never returns
  true for gate-unequal strings) with the documented non-ASCII-case exception.
- No typed failure is thrown for unsupported characters: they are handled by
  the gate, which is the correct ECMAScript answer for all non-case-fold pairs.
- All other `==` operands (number, boolean, mixed, object) keep the existing
  `operator_equals` lowering and `abstractEquals` semantics unchanged.

## Status: GO — wired into production

- IR `abstractEq` gains `strictStrings?: boolean`; the frontend sets it only
  when both operands are statically `string`. Constants still fold via
  `abstractEquals` (case-sensitive) and never reach the costume path.
- `backend-native/src/string-equality.ts` emits the inlined comparison;
  `index.ts` adds 53 probe costumes to the calling sprite and drains the
  generated statements into the enclosing statement's prelude.
- Every other `==` site (number, boolean, mixed) is unchanged.
- Golden cases: byte-identical — no existing golden project contains a
  runtime string `==`, so no snapshot changed.
- Non-ASCII case folds (`É`/`é`, `Σ`/`σ`) remain a documented limitation in
  this document; the build report's existing `TSCR2003` warning on `==` covers
  the approximation. This is NOT claimed as full ECMAScript equivalence.

The earlier `runtime-equality-spike-report.md` (NO-GO) is superseded: it tested
costume identity as a total mechanism. This fix uses the gate so costumes only
discriminate ASCII case.
