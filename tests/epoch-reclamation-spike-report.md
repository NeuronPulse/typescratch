# Spike A — Epoch-based orphan frame reclamation (2026-11-18)

**Verdict: NO-GO under the current Extension ABI. Do not implement layer 3.**

Plan reference: `ABI_COMPLETION_PLAN.md` Problem 2 layer 3. It requires giving
each frame an owner thread + epoch, advancing the epoch on clone-delete /
script-stop, and reclaiming old-epoch frames only after a full VM step with no
pending `frameGet`. The plan's own gate: "Requires a VM-level lifecycle hook
that TurboWarp extensions do not currently expose — must be proven feasible
before design is committed."

## What was verified (headless scratch-vm, no browser)

`tests/epoch-reclamation-spike.test.ts`, 3/3 passing:

1. **Host DOES have the events.** `runtime.disposeTarget(target)` on a real
   loaded project fires `targetWasRemoved` on the VM's EventEmitter. The
   scratch-vm host therefore has the raw lifecycle signal needed.
2. **Worker CANNOT see them.** The generated extension preamble
   (`frameExtensionPreamble`) is pure worker JS over `frames`/`freeIds`/
   `MAX_ORPHANS`; every frame op handler is `(args) => ...`. Neither the
   preamble nor any frame op body references `vm`, `runtime.on`,
   `targetWasRemoved` or any event subscription.
3. **No owner/epoch concept exists.** Frame records are `{ slots: Map }`;
   `frameFree` tombstones status and pushes to `freeIds`. No `ownerThreadId`,
   `epoch`, `threadId` or `cloneId` anywhere in the ABI body.

## Why this is NO-GO

The sandbox boundary is the blocker, not the algorithm. A TurboWarp extension
runs in a worker that receives only call arguments; it has no reference to the
host VM and cannot subscribe to `targetWasRemoved` / `PROJECT_STOP_ALL`. To get
epoch advancement you would need a **new host hook** that forwards VM lifecycle
events into the extension worker (a new Extension ABI capability), plus a
definition of "no pending `frameGet` for that callId" across the async boundary.

Adding that hook changes the Extension ABI contract. Per the project's rule —
do not present an ABI as implemented when it is not — layer 3 stays **out**.
Layer 2 (`--abi-frame-orphan-limit`, soft cap with typed failure) remains the
answer, and the existing "orphans accumulate until worker restart" contract is
unchanged.

## What would unblock it

A separate milestone that (a) defines a host→worker lifecycle event channel in
the Extension ABI, (b) proves in real TurboWarp that the event arrives before
any surviving `frameGet`, and (c) updates `BuildReport` to state that automatic
reclamation is active. None of that was authorized or implemented here.
