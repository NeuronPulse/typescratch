# Generic Scratch blocks — object calls + `Scratch.do` / `Scratch.get` (2026-11-18)

**Status: IMPLEMENTED.** Original Scratch blocks are written with an object
call (`Scratch.motion.moveSteps(10)`), no string opcodes. Any block not in the
curated object table — including third-party extension blocks — is available
through `Scratch.do` / `Scratch.get` with a literal opcode.

## Object-call syntax (preferred)

```ts
Scratch.motion.moveSteps(10);
Scratch.looks.say("hello");
const sum = Scratch.operators.add(20, 22);
Scratch.motion.setRotationStyle("left-right"); // static menu field argument
const x = Scratch.motion.xPosition();
```

**Design reset (user directive):** operators are TypeScript syntax (`a + b`,
`a == b`), not object calls — the former `Scratch.operators.*` namespace was
removed. Variables are plain `let` (sprite-private by default, `@global` for
cross-role Stage variables), not `Scratch.global(...)` handles with `.get()`.

**`runtime.d.ts` is the single source of truth** — there is no separate block
table. Each method declaration carries all metadata the compiler needs:

```ts
/** @tscr opcode motion_movesteps */
moveSteps(STEPS: number): void;              // param name = Scratch input;
                                             // void = command (statement)
/** @tscr opcode motion_xposition */
xPosition(): number;                         // non-void = reporter
/** @tscr opcode motion_setrotationstyle */
setRotationStyle(/** @tscr field */ STYLE: string): void;  // @tscr field = static menu
```

The frontend reads this from the TS symbol (verified to originate in
`runtime.d.ts`): `@tscr opcode` gives the opcode, parameter names give Scratch
input names, `@tscr field` marks static menu arguments, and the declared return
type distinguishes command from reporter. Adding a block is one d.ts line —
no table, no generator, no second place to keep in sync. Blocks outside the
declared namespaces still use `do`/`get`.

**Commands cannot be used as values.** `const x = Scratch.looks.say("hi")`
is rejected with `TSCR2001`: a command emits a statement and has no value.
This fixes the awkward "command that looks like a reporter" problem at the
semantic level (TS types already show `void`; the compiler now enforces it).


## Syntax

```ts
import { Scratch } from "@typescratch/runtime";

// command (any opcode)
Scratch.do("motion_movesteps", { STEPS: 10 });
Scratch.do("looks_say", { MESSAGE: "hello" });

// static menu field (3rd argument)
Scratch.do("motion_goto", {}, { TO: "_random_" });

// reporter (any opcode), generic return type
const x = Scratch.get<number>("sensing_xposition");
const sum = Scratch.get<number>("operator_add", { NUM1: 20, NUM2: 22 });

// extension blocks — opcode emitted verbatim
Scratch.do("my_extension_command", { VALUE: 7 }, { MODE: "x" });
const v = Scratch.get<number>("my_extension_reporter", {});
```

`inputs` values are TypeScript expressions (lowered normally); `fields` values
are string literals (menu selections / fixed text). Unknown reporter opcodes
evaluate to `0` in the synchronous IR interpreter — real behavior is verified
on scratch-vm.

## Why this shape

`runtimeNameOf()` resolves a call's symbol to `@typescratch/runtime`, so a
single pair of explicitly-named functions is enough to expose the whole block
universe. No per-opcode declaration table to maintain; new Scratch versions and
third-party extensions work immediately.

## Implementation

- IR: new `raw` Expr and `rawStmt` Stmt carrying `opcode`, named `inputs`,
  static `fields`. All exhaustive walkers were synchronised (ir, analysis,
  ir-opt, planner, backend-native, interpreter) — the same fan-out as `tryCall`.
- frontend: `Scratch.do/get` parse a literal opcode plus object literals for
  inputs/fields into `rawStmt`/`raw`; non-literal opcodes and non-literal fields
  are rejected with `TSCR2001`.
- backend-native: emits the opcode directly via `GraphBuilder.add` with fields
  and named inputs; no intrinsic lookup, so any opcode passes through.
- `IntrinsicSpec.fields` was also added for the typed intrinsic path (used by
  `operator_mathop`); raw blocks carry their own fields independently.
- `allCommands()` deliberately does NOT treat `rawStmt` as an intrinsic command,
  so the planner's "unknown command intrinsic" check does not reject raw blocks.

## Verification (headless scratch-vm, no browser)

`tests/raw-blocks.test.ts`, 5/5 passing:

1. `Scratch.do("looks_say", ...)` emits the `looks_say` opcode.
2. A raw command + raw reporter (`operator_add`) run in real scratch-vm and
   produce SAY `["42", "from raw"]`.
3. `Scratch.get` emits an arbitrary reporter with named inputs.
4. Static field `TO: "_random_"` round-trips into the generated
   `motion_goto` block's `fields`.
5. Arbitrary non-Scratch extension opcodes are emitted verbatim.

`pnpm verify` 6/6, typecheck/lint clean, golden unchanged.

## Boundaries

- This is a block escape hatch, not a typed wrapper per block: the compiler
  emits the exact opcode/inputs/fields you give it. It does not validate that
  the opcode exists in the target VM — a typo produces a block the VM ignores,
  which is the same contract as writing an unknown extension opcode by hand.
- `inputs` maps to Scratch substack inputs by block id, so a value expression
  can be passed anywhere a Scratch input is expected.
- Interpreter support for reporter semantics is intentionally partial (basic
  `operator_*`); full fidelity lives in scratch-vm E2E.
