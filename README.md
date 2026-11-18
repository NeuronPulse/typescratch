<p align="center">
  <img src="docs/assets/logo.svg" width="120" alt="TypeScratch logo">
</p>

# TypeScratch

**Write TypeScript. Build Scratch.** A compiler toolchain: source → type-checked AST → structured HIR → backend planner → Scratch project graph → `.sb3`.

## 0. What this actually is

If your first thought is "just run `tsc` and translate the JavaScript", read that pipeline again. Emitting JavaScript is exactly where the types, symbols and side-effect information Scratch needs go to die.

| What it isn't | Why |
| --- | --- |
| A text-to-scratchblocks rewriter | Nested `if` blocks stop being funny very quickly |
| A JavaScript runtime inside Scratch | The generated `.sb3` contains blocks, not an interpreter — unless you asked for a TurboWarp extension |
| A "compilation failed, just emit JS" fallback | The Extension backend is a first-class target, not a bin |
| A compiler for arbitrary TypeScript | See §5; unsupported constructs get a diagnostic with a source location |

One frontend, one IR, two backends, and a compatibility report that does not flatter you.

## 1. Install

Node.js 24 or newer, pnpm 12. The sprites have no requirements whatsoever.

```bash
pnpm install
pnpm verify         # typecheck, lint, tests, goldens, VM conformance, CLI bundle
pnpm build          # dist/hello.sb3
pnpm build:default  # dist/default.sb3
pnpm build:hybrid   # dist/hybrid.sb3 (TurboWarp)
```

Open the `.sb3` in Scratch or TurboWarp. There is no runtime to install.

For a single source file:

```bash
pnpm typescratch build --entry examples/hello-native/main.ts --target scratch --out dist/hello.sb3
```

## 2. A program

```ts
import { Scratch } from "@typescratch/runtime";

const score = Scratch.global<number>("score", { initial: 9 });

Scratch.onFlag(() => {
  let i = 0;
  while (i < 3) {
    i++;
    if (i % 2 === 0) Scratch.say(`even: ${i}`);
    else Scratch.say(`odd: ${i}`);
  }
  score.set(Math.sqrt(score.get()));
});
```

`Math.sqrt` maps to the native `operator_mathop` block. `Math.hypot` has no native equivalent and becomes an extension reporter. Short-circuit operators lower to control flow because Scratch evaluates both sides of `operator_and` and TypeScript does not. TypeScript won that argument.

## 3. Workspace

`pnpm scaffold my-game` creates the default project:

```text
my-game/
├── tscr.config.json
├── project.d.json
├── src/Sprite1.ts
└── assets/
    ├── Sprite1/
    │   ├── sprite.json
    │   ├── sound/sound.json
    │   └── costumes/costumes.json, default.svg
    └── stage/
        ├── stage.json
        ├── sound/sound.json
        └── backdrops/backdrops.json, stage.svg
```

One file in `src/` is one sprite. A directory groups several scripts under one sprite; a nested directory starting with `&` becomes its own sprite. `Stage` maps to the stage. The default costume is the JvavScratch ice-cream SVG and the default backdrop is blank. Global variables live on the stage; local variables belong to their sprite — Scratch has no general-purpose stack frame, so this is explicit rather than implied.

```bash
pnpm typescratch build --config my-game/tscr.config.json --out dist/my-game.sb3
```

## 4. CLI

| Command | Description |
| --- | --- |
| `typescratch init [path]` | Scaffold the default `Sprite1` workspace (also `pnpm scaffold`) |
| `typescratch build` | Compile and write outputs |
| `typescratch check` | Validate semantics and compatibility without writing files |
| `typescratch explain` | Print the lowering plan |

Flags: `--entry <file>`, `--config <file>`, `--target scratch|turbowarp`, `--abi-profile native|extension|auto`, `--out <file>`.

`--abi-profile` says who you'd *prefer* to implement the ABI; it is orthogonal to `--target`. `--target scratch --abi-profile extension` still fails with `TSCR5001` — asking official Scratch to load a custom extension is optimism, not a build.

On TurboWarp, `--abi-profile extension` is a **mixed** deal, and the build report says exactly who did what: Frame storage goes to an Extension `Map<callId, CallFrame>`, while Call/CFG/Memory/Dispatch stay Native. `auto` currently resolves to `native` (an empty capability table is not a candidate — nobody gets elected on zero promises). `tscr.config.json` takes the same `abiProfile` key.

> Frame storage is released by tombstone, not deletion: the caller reads its return value *after* the callee's epilogue, so deleting the frame there would be like throwing away the envelope while delivering the letter. Orphan frames from stopped scripts still accumulate until worker restart — `--abi-frame-orphan-limit N` makes the ninth orphan fail loudly instead of quietly hoarding memory. Recursion under `--abi-profile extension` is refused at plan time (`TSCR3002`): TurboWarp's async frame reads shuffle the procedure stack, so a recursive factorial would confidently answer `1`. Native recursion still works and gets the right `120`.

A build writes the `.sb3`, a readable `*.project.json`, a build report, a source map, and for TurboWarp targets the generated extension JS and an embedding manifest.

## 5. Language subset

Supported: `number`, `string`, `boolean`, `let`/`const`, assignment and compound assignment, unary and binary operators, `if/else`, `while` with `break`/`continue`, restricted `for`, template strings, top-level `function` declarations with `return`, `Scratch.onFlag`, typed event hats (`onKey`, `onSpriteClicked`, `onClone`, `onBackdrop`, `onBroadcast`), `Scratch.say/wait/move/hide/show`, `Scratch.global/local` with `get/set/change`, `Scratch.list` with `push/insert/replace/deleteAt/clear/item/length`, `Scratch.array` with `get/set/length`, `Scratch.free`, classes with number/string fields and methods (`new`, field access, method calls), recursive functions, edge-activated hats (`onGreaterThan`), and the native Math functions. APIs are resolved by symbol, so `import { Scratch as S }` works too.

Any Scratch block — original or extension — can be emitted with `Scratch.do(opcode, inputs?, fields?)` (command) and `Scratch.get<T>(opcode, inputs?, fields?)` (reporter). Input values are TypeScript expressions; fields are static string literals (e.g. `Scratch.do("motion_goto", {}, { TO: "_random_" })`). The opcode is emitted verbatim, so third-party extensions work without compiler changes. See `tests/raw-blocks-design.md`.

`Scratch.waitUntil(condition)` is a language-level suspend point: the script pauses and other scripts run until the condition becomes true (checked once per VM step). No broadcast/hat, no frame-slot continuation — the VM thread's own stack is the saved state, which is what the resumption spike proved. Yielding calls inside a `@warp` method are rejected (`TSCR3005`) because warp never yields. This is the minimal Phase C primitive; JS `async`/`await` and generators are still not supported.

`==` between two statically-`string` operands is case-sensitive on Native: the compiler uses `operator_equals` as a fast gate, then a 53-costume probe sprite checks only ASCII letter case (and length separates `"10"` from `"10.0"`). Non-ASCII case folds (`É`/`é`) remain case-insensitive — a documented limit, not a silent surprise. Mixed-type comparisons keep the Value ABI `abstractEquals` contract. See `tests/runtime-equality-fix-design.md`.

Scratch has no `break` or `continue`. The IR pass rewrites a loop that uses them with `done`/`skip` flags, guards every remaining statement and folds both flags into the loop condition. It is more blocks than a `goto` would be, but a `goto` is not on the menu. `for` loops reject them: the incrementor sits at the end of the lowered body, so `continue` would skip it and quietly change the program.

`onKey` takes a `KeyName` union, so `"space"` compiles and `"not-a-key"` does not. Event hats become their native blocks — including `BROADCAST_OPTION` with a deterministic broadcast ID registered on the stage — and the VM conformance run fires them with `startHats`, because pressing a green flag will not press a key for you.

List indices are zero-based, like TypeScript arrays. The compiler adds one before emitting `data_*` blocks, because Scratch starts counting at one. It is a small translation, but getting it wrong would be quietly hilarious.

An `ir-opt` pass runs before the backend planner: constant arithmetic and string joins fold, dead branches and loops disappear, and `x + 0` / `x * 1` are simplified. Comparisons, `%` and cross-type equality are deliberately left alone — folding those with JavaScript rules would smuggle the wrong semantics into the project. Build reports say how many folds, removals and control-flow rewrites happened; `compile({ optimize: false })` is there when you want to see the unoptimised version.

Objects are references, not per-class globals. A `class` with number/string fields and methods compiles to Stage-owned parallel lists (`heap.classId`, `heap.field.x`, ...) where one index describes one object; `new` appends a slot and returns its ObjectRef, and `Scratch.array<number>(3)` is an ObjectRef with a `length` field and a disjoint slice of `heap.array.items`. Array sizes are compile-time constants, so the whole allocation stays one unbranched, yield-free sequence. `p.step(2)` emits a single `invoke_virtual` operation: the Native profile compares `heap.classId[p]` against each implementing class and calls the matching custom block. Two classes with a `step` method get distinct `proccode`s — Scratch registers procedures by proccode, and quietly reusing one would dispatch every object to the last definition.

Recursion works because frame state lives in slots indexed by an invocation token, not in persistent variables. Each call also saves its token in `abi.frame.callToken` under the caller's frame id, so an inner call cannot overwrite the key the outer call needs to read its own return value. `TSCR3002` is gone; the IR interpreter mirrors the same save/restore stack.

`@warp` / `@noWarp` on a **method** set the generated Scratch procedure's warp flag. Unannotated methods stay non-warp; warp is opt-in because it changes scheduling, not just speed. TS6 makes `@warp function f()` a syntax error, so the decorator lives on methods (which lower to the same procedures). Recursive `@warp`, conflicts, duplicates and `@warp` under `--abi-profile extension` are rejected (`TSCR3003`/`TSCR3004`). See `tests/warp-decorator-design.md`.

`onGreaterThan("timer", n, handler)` emits `event_whengreaterthan` with a `event_whengreaterthanmenu` shadow block. It is edge-activated: the VM evaluates the predicate on every frame and starts the script on the false-to-true transition, so the conformance run drives `runtime._step()` instead of calling `startHats` by hand.

`Scratch.free(ref)` releases an ObjectRef explicitly: the slot is tombstoned, its id returns to `heap.freeObjects`, and its array range is registered in `heap.array.freeStart` / `freeSize`. The next allocation reuses the last interval that fits, splits any remainder, and clears the reused slots — all from a compile-time constant size, so there is no loop, no yield and no garbage collector smuggled into Scratch. Release order does not matter: ranges are never shifted. Three green flags leave every heap list at the same length, including a non-LIFO example that frees the earlier range first.

Six runtime contracts — Value, Call, Frame, Memory, Dispatch, Execution — are declared once in the ABI layer. The planner derives which ones a project actually uses from lowered IR, prints them (`abi contracts: value, call, frame, memory, dispatch`), and rejects unsupported ones with `TSCR4001` before any block is emitted. A `Scratch.say("hello")` project reports `none (static lowering only)`. Execution ABI is a state model only: `ExecutionContext { threadId, frameId, status }` with a 25-entry transition matrix and single-owner frames, no emitted blocks and no language-level `throw`/`yield` yet. Capability checks read the **actual lowering**, not the declarative profile, so `--target turbowarp --abi-profile auto` is not rejected for a contract that native implements.

`--abi-profile auto` asks the capability table instead of assuming "TurboWarp means extension": a profile with no implemented contract can't win an election, so `resolved` and `lowering` agree and the report says why (`abi choice: auto: cheapest capable profile for [...]`). Every ABI operation carries an explicit cost (frame push/pop, tag/untag, heap access, dispatch); consecutive operations in one script scope may merge into a region, but the planner counts **one Extension boundary per generated block**, not per region — `mergeAbiRegions()` is an accounting shortcut, not a promise that the VM makes one crossing. Static lowering stays free — `1 + 2` is still one `operator_add`, with zero regions and zero cost.

`try { ... } catch (e) { ... }` and `throw "string"` lower to recoverable typed failures in IR and run in the interpreter. Native Scratch has no try/catch primitive, so those projects get an explicit `TSCR3001` diagnostic rather than a silent no-op — the compiler declines to pretend the envelope arrived.

Not supported: promises, `async`/`await`, generators, `eval`, dynamic imports, closures, arbitrary npm packages, DOM and Node APIs.

TypeScratch does not silently change semantics. Cross-type equality (Scratch considers `"10"` and `10` close friends), the difference between JS `%` and Scratch `mod`, and booleans stored as `"true"` strings are all reported rather than guessed. The build report states the numeric profile it compiled against.

`==` / `!=` now lower to a dedicated `abstractEq` IR expression backed by the Value ABI `abstractEquals()` contract — ECMAScript ToPrimitive/ToNumber with the `tsTo*` rule set, verified against a 256-case matrix using JavaScript `==` as the oracle. `ir-opt` folds literal operands with this exact contract, so `"A" == "a"` compiles to `false` and `"HELLO" == "hello"` to `false` with no runtime comparison at all. `===` / `!==` remain strict and still warn on cross-type operands.

> [!WARNING]
> **Runtime `==` on the native Scratch backend is still an approximation.** Scratch's `operator_equals` calls `Cast.compare`, which coerces numeric-looking strings, compares case-insensitively, and cannot detect `NaN`. When an operand is not a compile-time constant, `abstractEq` lowers to that approximation and keeps a `TSCR2003` warning. Concretely, a runtime `"A" == "a"` can evaluate to **true** on native Scratch, and `NaN == NaN` disagrees with JavaScript. Only literal comparisons are exact today. A costume-name proof of concept (`dist/case-sensitive-poc.sb3`, `tests/case-sensitive-costume.test.ts`) confirms costume switching is case-sensitive and can drive exact character comparison, but it costs 64 costumes and ~45 blocks per comparison, mutates shared sprite state (unsafe under concurrency), and misreports unsupported characters. It is deliberately **not** wired into the compiler. The IR interpreter and Extension profile use the exact contract regardless of operand kind.

The Value ABI keeps the two conversion rule sets apart: `castTo*` models Scratch `Cast`, `tsTo*` models ECMAScript. Tagged pairs `[n|s|b|o|u|z, payload]` make `===` compare tags first, so `NaN === NaN` stays false and `"1" === 1` stays false on a platform that disagrees. Static paths never see a tag. A real `scratch-vm` run confirms lists preserve `NaN`, `Infinity` and `-0`, so number payloads stay plain JS numbers instead of growing a string encoding nobody asked for.

A function call lowers to a native `procedures_call` custom block, and its return value travels through `abi.frame.returnValue` / `abi.frame.returnTag`, indexed by an invocation token allocated at the call site. The token comes from `abi.freeFrames` when one is free and otherwise bumps `abi.nextFrameId`; the epilogue tombstones the slot and hands the id back, so a long-running script does not grow the frame lists forever. `return` is a CFG rewrite — a `returning` guard plus an epilogue — because `control_stop this script` would unwind the whole procedure stack. Every invocation resets its own flags, so nested calls and two event threads calling the same function keep their frames apart. Boolean parameters use their own argument reporter. Recursion is rejected with `TSCR3002`: a semantic restriction, not a frame-layout limitation.

Four constraints are checked before a single block is emitted. `NaN`, `Infinity` and negative `%` literals are rejected. `wait`, broadcasts and sandboxed extension calls are marked as yielding, and reading a temporary across one of them is an error. Temporaries are partitioned per hat script so concurrent scripts cannot clobber each other. And no boolean is ever stored in a Scratch variable: flags are lowered to `0`/`1`. Nineteen numeric fixtures compare JavaScript and Scratch semantics side by side, because "roughly the same" is not a specification.

| Code | Area |
| --- | --- |
| `TSCR1xxx` | TypeScript frontend |
| `TSCR2xxx` | Language subset |
| `TSCR3xxx` | Lowering |
| `TSCR4xxx` | Runtime ABI: yield boundaries, variable types, script partitioning, numeric profile |
| `TSCR5xxx` | Target compatibility |
| `TSCR6xxx` | Performance |

## 6. TurboWarp extensions

Projects using custom extensions cannot be uploaded to the official Scratch website. The build report says so every time, in case anyone was hoping it had changed its mind.

The generated project is self-contained. `project.json` carries the extension ID and the JS as a data URL:

```json
{
  "extensions": ["tscr4995f9dafc31"],
  "extensionURLs": {
    "tscr4995f9dafc31": "data:application/javascript;base64,..."
  }
}
```

TurboWarp loads it automatically; block opcodes are prefixed with the extension ID. With `--target scratch` neither field is written and extension-only operations fail with `TSCR5001`.

## 7. How it works

```text
TypeScript → typed AST → HIR → control-flow lowering → ir-opt → backend planner
  → native lowering    → project graph → SB3 exporter
  → extension lowering → TurboWarp JS
```

Sixteen packages in a pnpm workspace: `language`, `diagnostics`, `ir`, `ir-opt`, `runtime-abi`, `frontend-ts`, `workspace`, `testing`, `backend-planner`, `backend-native`, `backend-turbowarp`, `graph`, `exporter-sb3`, `exporter-turbowarp`, `compiler`, `cli`.

Three boundaries: TS AST is not IR, IR knows nothing about Scratch JSON, exporters only handle format. The TypeScript Compiler API is pinned to 6.0.3 and used only in `frontend-ts`. If TypeScript 7 ever ships a stable API, only one package has to care.

## 8. Development

```bash
pnpm verify           # the whole gate, orchestrated by turbo
pnpm build:showcase   # dist/showcase.sb3 — the full language demo, open it in Scratch 3
pnpm trace:showcase   # dist/showcase.trace.txt — per-frame VM state changes for 3 green flags
pnpm snapshots:update # refresh five golden artifacts per case
pnpm build:packages   # tsdown/rolldown CLI bundle
```

177 Vitest tests cover HIR lowering, block graph integrity, deterministic output, extension embedding, workspace roles, default assets, list operations, typed event hats, IR optimization, break/continue control flow, numeric conformance, the four ABI constraints, Value ABI tagged pairs and strict equality, the ECMAScript/Scratch conversion split, `abi-profile` capability rules, real-VM numeric representation, thread-interleaving token atomicity, per-script control-flow isolation, custom-procedure `mutation` round trips, concurrent procedure-argument isolation, the Native frame allocator's free-list/200k bound, real-VM frame return-slot isolation, function returns with nested, early, re-entrant, boolean-parameter, tagged-return and recursive cases, the heap allocator's parallel-list layout and 200k bound, per-class field defaults, ObjectRef identity, dispatch-target collection, distinct method `proccode`s, real-VM object/field/array traces, and edge-hat menu shadows that fire from `runtime._step()`. Some tests call the real `scratch-vm` deserializer to verify shadow blocks and extension IDs. `pnpm verify:vm` is no longer optional theatre: a jsdom shim gives headless `scratch-vm` the DOM it wants, twenty-three compiled projects are actually run, and their SAY/variable/list traces are compared against an independent IR interpreter. Five golden artifacts — HIR, backend plan, graph, extension JS, build report — are pinned for ten cases. CI runs the same gate on Node 24 and 26.

`pnpm verify:e2e` is a separate, browser-and-network-dependent gate: it opens the real TurboWarp editor in Chrome, loads `dist/hybrid.sb3` through TurboWarp's `?project_url=data:` loader, authorizes the extension declared in `extensionURLs`, and asserts SAY `5` / `HELLO` / `2` through `window.vm.runtime`. This proves the embedded data URL loads with no sidecar file and that extension reporters actually execute. It stays outside `pnpm verify` because it needs a browser and internet access. The Extension **Frame storage** is live and covered by `pnpm verify:e2e:frame`: single, nested and re-entrant calls produce the same SAY traces in TurboWarp as in the headless VM. Call/CFG stays Native, and the planner says so per operation.

`recordTrace()` runs a project for any number of green flags and records per-frame diffs of variables, lists and SAY output in headless `scratch-vm`; compiler-internal state is filtered out of the frame log but retained in each round's full snapshot. `pnpm trace:showcase` writes a readable log to `dist/showcase.trace.txt` with a per-round compiler-state summary, so heap and frame growth is visible without opening the editor. One frame is a scheduling boundary, not a single block: `runtime._step()` drains all runnable threads, so the diff is the net change of that frame.

## License

MIT. See [LICENSE](LICENSE).
