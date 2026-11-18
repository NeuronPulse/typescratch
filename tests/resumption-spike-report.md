# Spike B — Thread resumption for Phase C (2026-11-18)

**Verdict: GO for the gate. Phase C implementation is NOT started — it needs an ABI change and is out of this completion plan.**

Plan reference: `ABI_COMPLETION_PLAN.md` Problem 3 Phase C ("yield / async /
generators"). Gate: "do not start until a spike proves a suspended Scratch
thread can be resumed without `broadcast and wait` (which is a yield itself and
would deadlock the model). Document the spike result before any IR work."

## What was verified (headless scratch-vm, no browser)

`tests/resumption-spike.test.ts`, 2/2 passing:

1. **VM-native suspend/resume works.** On a real compiled project with
   `Scratch.wait(0.2)`, a live thread is found with a non-empty stack. Setting
   `thread.status = Thread.STATUS_YIELD` (the exact value `util.yield()` writes)
   suspends it; the next `runtime._step()` clears it back to `STATUS_RUNNING`,
   does **not** abort it (`isKilled === false`), preserves its stack, and the
   thread later reaches its final `SAY`.
2. **No broadcast/hat needed.** Source inspection confirms: `STATUS_YIELD = 2`
   is a plain thread status; `BlockUtility.yield()` only writes
   `this.thread.status = Thread.STATUS_YIELD`; `Sequencer.stepThread()` clears
   it to `STATUS_RUNNING` on the next pass. `util.yield()` contains no
   broadcast or hat operation. The gate is satisfied.

## Why Phase C is still not implemented

The gate proves the *host* can suspend/resume. It does not make language-level
`yield` / `await` / generators cheap:

- The IR has **no** `suspend`/`resume` statement, no continuation and no
  `resumeAt`. Adding them means touching every exhaustive walker (ir,
  analysis, ir-opt, planner, interpreter, backend-native) — the same fan-out
  that `tryCall` required.
- `packages/runtime-abi/src/execution.ts` already models `suspended` and the
  `running → suspended → running` transition, but nothing instantiates it in
  lowering or the interpreter. README states the state model is foundation
  only: "no emitted blocks and no language-level throw/yield yet".
- A real `yield` must store the continuation in a frame slot and define what
  happens to frames on stop/clone-delete across a suspension. That **changes
  the calling ABI and frame lifetime**, which is outside this completion plan
  and requires explicit authorization.

So: spike result documented (GO), no IR/ABI work started, no pretence that
`async`/generators exist. Existing `Scratch.wait` / `broadcastAndWait` already
yield at the VM level and are unchanged.

## What a Phase C milestone would need

1. IR `suspend { resumeAt }` + `resume` semantics; all walkers synchronised.
2. Continuation encoding in frame slots; `ExecutionContext` wired into the
   interpreter and Native backend.
3. Warp interaction rule (a warped procedure region cannot suspend — see
   `warp-decorator-design.md`).
4. Stop/clone-delete semantics for a suspended frame (the Problem 2 layer 3
   boundary applies here too).
5. Golden cases for new IR; `TSCR4002` yield-boundary rules extended.

None of this was implemented in this spike.
