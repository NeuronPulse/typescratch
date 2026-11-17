# Function-level Warp Decorator — Design & Verification (2026-11-17)

## Final API

`@warp` / `@noWarp` are **compile-time method decorators** exported from
`@typescratch/runtime`:

```ts
import { Scratch, warp, noWarp } from "@typescratch/runtime";

class Calc {
  @warp fast(x: number): number { /* ... */ }
  @noWarp slow(x: number): number { /* ... */ }
  plain(x: number): number { /* ... */ } // default: non-warp
}
```

**Why methods, not top-level functions.** The requested `@warp function f()`
form is impossible with the pinned TypeScript 6.0.3: `canHaveIllegalDecorators`
explicitly lists `FunctionDeclaration`, so a decorator there is a syntax error
(`TSCR1001`) regardless of compiler options. TS6 only allows decorators on
classes, methods, properties, parameters and accessors. TypeScratch methods
*are* `FunctionDecl`s and lower to the same procedures as standalone functions,
so a method decorator carries the identical semantics with a syntax TS6
accepts. A test asserts `@warp function` fails at TSCR1001 rather than being
silently accepted.

## Compile-time semantics

- `FunctionDecl.warp?: boolean` (new IR field, optional). Undefined = default
  (non-warp), so existing projects and all golden snapshots are unchanged.
- Frontend `parseWarpDecorator` records `warp`/`noWarp` as `true`/`false`.
  Unknown decorators, duplicates, `@warp`+`@noWarp` conflicts, and any warp
  decorator outside a method are hard `TSCR3003` errors — never silently
  ignored.
- `@warp` on a recursive method is `TSCR3003`: a warped procedure never yields
  and recursion under warp has undefined stack behavior. Method call edges are
  now recorded in `callEdges` so this is detectable.
- `--abi-profile extension` with any `@warp` method is `TSCR3004` at plan time:
  warp suppresses scheduler yields, and the interaction with an async Extension
  frame handler is not verified. Refuse rather than emit a project whose
  scheduling differs silently from Native.

## Data flow

`frontend-ts declareMethod` → `FunctionDecl.warp` → ir-opt / planner keep the
field via object spread → `backend-native ProcedureInfo.warp` →
`procedures_prototype.mutation.warp = "true" | "false"`.

Call sites do **not** need the callee's warp flag: warp is a property of the
procedure definition, not of the call ABI. No ABI, frame lifetime, or execution
state changes were needed, so this decorator was safe to implement within
scope.

## Native lowering

`backend-native` previously hard-coded `warp: "false"`. It now reads
`fn.warp === true`. Nothing else about the procedure (proccode, argument ids,
frame slots, return value handling) changes.

## Verification (actually executed, headless — no browser)

`tests/warp-decorator.test.ts`, 9/9 passing. It uses `createStepSession`
(real headless scratch-vm, no browser) and a new `StepSession.procedures()`
observer that reads the actual loaded `procedures_prototype.mutation.warp`:

- `@warp` method → mutation.warp `"true"`, SAY hook yields `"42"`.
- `@noWarp` and unannotated → `"false"`, SAY `"42"`.
- call chain `@warp outer` → plain `inner` → `["false","true"]`, SAY `"41"`.
- recursive `@warp` → TSCR3003; duplicate/conflict → TSCR3003; non-method
  decorator and unknown decorator → TSCR3003.
- extension profile + `@warp` → TSCR3004.
- `@warp function` (top-level) → TSCR1001, not accepted.

`pnpm verify`: 6/6 tasks, golden snapshots unchanged (0 diffs). `pnpm lint`:
0 warnings/errors. `pnpm typecheck`: clean.

## Scheduling impact (analysis, not a benchmark)

Warp is not a generic optimization. In Scratch a warped procedure runs its body
without yielding to the VM scheduler, which changes long-loop responsiveness,
inter-script scheduling, and the timing of stop / clone-deletion interruptions.
TypeScratch therefore keeps non-warp as the default and requires an explicit
decorator. Frame allocation/free is unchanged (same synchronous list/Map ops),
but a future suspension/yield model (Phase C, out of scope) must treat a warped
region as non-suspendable — recorded here so that work does not accidentally
assume warp is transparent.

## Unsupported forms

- Top-level `@warp function` (TS6 syntax error, TSCR1001).
- Class-level, property, parameter, accessor decorators (TSCR3003).
- Recursive `@warp` methods (TSCR3003).
- `@warp` under the extension ABI profile (TSCR3004).
- Unknown decorators (TSCR3003) and duplicate/conflicting warp decorators
  (TSCR3003).
