# Phase C minimal implementation — `Scratch.waitUntil` (2026-11-18)

**Status: IMPLEMENTED (minimal language-level suspend). JS `async`/`await` and generators remain unsupported.**

Resumption spike (`resumption-spike-report.md`) proved a Scratch thread can be
suspended with `STATUS_YIELD` and resumed on the next `_step()` without
broadcast-and-wait. That makes a language-level suspend primitive possible
**without** the host hook / frame-slot continuation the original plan assumed.

## API

```ts
Scratch.waitUntil(condition: boolean): void;
```

Pauses the calling script; other scripts run. The condition is re-evaluated
once per VM step; while false the thread yields. When it becomes true the
thread continues from the very next block — its VM stack is the continuation,
so there is no `abi.frame.resumeAt`, no new ABI capability and no host hook.

## Implementation

- `packages/language/src/index.ts`: new `waitUntil` command intrinsic lowering
  to `control_wait_until` with the `CONDITION` boolean input, `effect: "yields"`;
  added to `YIELDING_COMMANDS`.
- `packages/language/runtime.d.ts`: declaration + semantics note.
- `packages/frontend-ts/src/index.ts`: a yielding command inside a `@warp`
  method is rejected with `TSCR3005` (warp procedures never yield; otherwise
  the suspension would be silently ignored).
- `packages/diagnostics/src/index.ts`: `WARP_YIELD = "TSCR3005"`.
- No IR `suspend` statement was needed: `waitUntil` is an ordinary `expr`
  intrinsic with a `yields` effect, so existing yield-boundary analysis
  (`TSCR4002`, temp read across yield) applies automatically.

## Why this is honest Phase C scope

The plan's Phase C text said a `yield` "must store the continuation in a frame
slot (`abi.frame.resumeAt`) … requires a host-level resumption hook". That was
written before the spike. The spike showed the VM already keeps the
continuation on the thread stack across `STATUS_YIELD`; `control_wait_until`
uses exactly that mechanism. So the minimal primitive needs no frame-slot
change and no new ABI — it is a real, verifiable suspend/resume, not a
simulation. We did NOT claim generator/await support, which would need IR
continuations and an Execution-ABI change.

## Verification (headless scratch-vm, no browser)

`tests/yield-until.test.ts`, 3/3 passing:

1. `waitUntil` lowers to a `yields`-effect command in IR.
2. A real project: one script pushes 1 then waits on `ready === 1`; a second
   script (key hat) pushes 2 and sets `ready = 1`. On headless scratch-vm the
   waiter is observably suspended (probe `[1]`, no SAY) for 30 steps, then
   resumes after the condition changes and finishes with probe `[1,2,3]` and
   SAY `"resumed"`.
3. `Scratch.waitUntil(...)` and `Scratch.wait(...)` inside a `@warp` method are
   rejected with `TSCR3005`.

The synchronous IR interpreter treats `waitUntil` as a single forward step —
it has no scheduler, so a suspend is not observable there; its API is unchanged
for all existing callers.

`pnpm verify` 6/6, typecheck/lint clean, golden snapshots unchanged (no
existing golden uses `waitUntil`).

## Not implemented (deliberate boundary)

- TypeScript `yield` expressions / `function*` generators.
- `async` / `await` and promise scheduling.
- `abi.frame.resumeAt` frame-slot continuation and the `suspended` Execution
  status being emitted into projects.
- Any TurboWarp extension-side suspend (the Extension ABI has no yield hook;
  same reason as the epoch-reclamation NO-GO).

These remain separate, explicitly authorized milestones.
