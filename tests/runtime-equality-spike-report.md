# Runtime String Equality Spike — Report (2026-11-17)

**Verdict: NO-GO. Do not wire into formal `==` lowering.**

This spike asked one question: can a helper sprite with case-sensitive costume
names implement ECMAScript string equality for an *arbitrary TypeScript
`string`*, not just ASCII? The answer is no — the mechanism produces silent
false positives for any character without a matching costume.

## Assets

- `tests/runtime-equality-spike.test.ts` — reproducible vitest spike (2 tests).
- `dist/runtime-equality-spike.sb3` — generated project, 15 character cases.
- `dist/runtime-equality-spike-concurrent.sb3` — two concurrent green-flag scripts, 40 comparisons each.
- `tests/case-sensitive-costume.test.ts` — earlier 8-case ASCII-only PoC (mechanism existence proof only).

## Method

Helper sprite `Probe` has 64 costumes: `__SENTINEL__` plus 63 ASCII characters
(`A-Z`, `a-z`, `0-9`, space). For each character position the project switches
to sentinel, switches to the character (via `operator_letter_of`), reads
`looks_costumenumbername(number)`, and compares the two costume numbers. Length
mismatch short-circuits to false. This is the exact mechanism the earlier PoC
used; the spike extends its inputs and concurrency.

## Character coverage — FAIL

Spike cases and observed results in `scratch-vm` (`createStepSession`):

| Case | Inputs | ECMAScript | Observed | Result |
| --- | --- | --- | --- | --- |
| ASCII case differs | `A` / `a` | false | false | pass |
| ASCII same | `a` / `a` | true | true | pass |
| empty | `` / `` | true | true | pass |
| length differs | `A` / `AA` | false | false | pass |
| prefix | `Ab` / `A` | false | false | pass |
| digits | `123` / `123` | true | true | pass |
| space | `a b` / `a b` | true | true | pass |
| Latin-1 same | `é` / `é` | true | true | pass (accidental) |
| **Latin-1 vs CJK** | `é` / `中` | **false** | **true** | **FAIL — silent false positive** |
| CJK same | `中` / `中` | true | true | pass (accidental) |
| emoji same | `😀` / `😀` | true | true | pass (accidental) |
| **emoji differs** | `😀` / `😁` | **false** | **true** | **FAIL — silent false positive** |
| **lone surrogate** | `\uD83D` / `\uDE00` | **false** | **true** | **FAIL — silent false positive** |
| unsupported vs ASCII | `é` / `e` | false | false | pass |
| unsupported in longer string | `aé` / `ab` | false | false | pass |

**Root cause:** `operator_letter_of` extracts one UTF-16 code unit. Any code
unit without a matching costume makes `looks_switchcostumeto` fail, leaving the
sprite on `__SENTINEL__`; both operands then read the sentinel number and are
judged equal. Two *different* unsupported characters therefore collapse to the
same sentinel — exactly the failure mode the task warned about. TypeScratch's
static `string` type does **not** imply ASCII, so a formal lowering would have
to fail closed on every non-costume code unit, which this mechanism cannot do
without an out-of-band character discriminator.

## Concurrency / state isolation — inconclusive on TurboWarp

Two green-flag scripts share one `Probe` sprite (global costume state), each
with private variables, 40 ASCII-only comparisons; script A compares `A`/`a`
(always false), script B compares `Zz9`/`Zz9` (always true), so any crosstalk
would flip a result.

- `scratch-vm` headless step session: A 40/40 correct, B 40/40 correct. No
  observed crosstalk.
- **TurboWarp E2E could not be completed.** The generated project has 64
  costumes that all reference one shared SVG asset (`md5ext` count = 1). In
  TurboWarp the project loads as an empty target (`blocks: [0,0]`), while
  `scratch-vm` accepts it. TurboWarp also returned intermittent Cloudflare 520
  during the attempt. Therefore concurrency safety under TurboWarp's actual
  scheduler — and in particular under warp execution — is **not established**.
  Do not infer it from sequential block order or from the headless result.

## Failure semantics

- Correct: ASCII `[A-Za-z0-9 ]`, empty string, length mismatch, prefix.
- Wrong silently: any pair of distinct characters outside that 63-character
  set (Latin-1, CJK, emoji, lone surrogates, control characters, punctuation
  such as `!` and `@`).
- No reliable fallback exists inside the Scratch block model: the costume
  number is the only observed value and it is identical for every unsupported
  code unit. There is no in-band signal distinguishing "same unsupported
  character" from "two different unsupported characters".

## Decision

**NO-GO.** The requirement is that every input entering the implementation path
must never silently produce a wrong boolean. This spike found a reproducible
class of inputs that do exactly that, so the mechanism must not be wired into
`backend-native/src/index.ts`. No production `==` lowering, `compiler/src/index.ts`
diagnostics, or golden case was modified by this spike.

Runtime string equality remains a documented limitation: literal-vs-literal
`==` is still folded correctly by `abstractEquals`; runtime string `==` still
uses Scratch `operator_equals` and is therefore case-insensitive. A future
attempt would need a fundamentally different discriminator (e.g. a verified
host-side extension that returns a typed equality result, subject to the same
ABI/scoping scrutiny as Frame storage) — a separate spike, not this one.
