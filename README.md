<p align="center">
  <img src="docs/assets/logo.svg" width="120" alt="TypeScratch logo">
</p>

# TypeScratch

**Write TypeScript. Build Scratch.** Source → type-checked AST → HIR → backend planner → Scratch project graph → `.sb3`.

If your first thought was "just run `tsc` and translate the JavaScript", consider that this is exactly where the types, symbols and side-effect information go to die. One frontend, one IR, two backends, and a compatibility report that does not flatter you.

## Install

Node 24+, pnpm 12. The sprites have no requirements whatsoever.

```bash
pnpm install
pnpm verify         # typecheck, lint, tests, goldens, VM conformance, CLI bundle
pnpm build          # dist/hello.sb3
pnpm build:hybrid   # dist/hybrid.sb3 (TurboWarp)
```

Open the `.sb3` in Scratch or TurboWarp. There is no runtime to install.

```bash
pnpm typescratch build --entry examples/hello-native/main.ts --target scratch --out dist/hello.sb3
pnpm scaffold my-game   # workspace: one file in src/ = one sprite
```

## A program

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
  Scratch.waitUntil(score.get() > 0);  // suspend, let other scripts run
  score.set(Math.sqrt(score.get()));
});
```

Native standard library: `Math.PI`/`E`, `abs`/`floor`/`ceil`/`round`/`sqrt`/`ln`/`log10`/`exp`, and `sin`/`cos`/`tan`/`asin`/`acos`/`atan` (radian↔degree conversion at the block boundary — Scratch counts degrees, JavaScript does not). Strings have `charAt`/`includes`/`length`; `toUpperCase`/`toLowerCase` need an extension reporter because Scratch has no native case blocks. Everything else (`pow`, `min`/`max`, `sign`, `indexOf`, `slice`, …) is deliberately absent — no native block expresses it without a loop or a conditional expression the IR doesn't have. Short-circuit operators are control flow because Scratch evaluates both sides of `operator_and` and TypeScript does not. TypeScript won that argument.

## Language

`number`/`string`/`boolean`, `let`/`const`, operators, `if/else`, `while` (`break`/`continue` included), restricted `for`, template strings, top-level `function` with `return`, classes with fields/methods and `new`, recursive functions, `global`/`local`/`list`/`array`/`free`, event hats (`onFlag`, `onKey`, `onSpriteClicked`, `onClone`, `onBackdrop`, `onBroadcast`, `onGreaterThan`), and the native Math functions. APIs resolve by symbol, so `import { Scratch as S }` works.

Scratch blocks use object calls:

```ts
Scratch.motion.moveSteps(10);
Scratch.looks.say("hi");
const x = Scratch.motion.xPosition();
Scratch.motion.setRotationStyle("left-right");
```

`packages/language/runtime.d.ts` is the single source of truth: parameter names are Scratch inputs, `@tscr opcode` / `@tscr field` JSDoc carry opcode and menu fields, and the return type separates commands from reporters. A command (`void`) used as a value is `TSCR2001` — a command emits a statement, not a value. 68 blocks are declared across `motion`, `looks`, `operators`, `sensing`, `sound`. Anything else, especially third-party extensions, uses `Scratch.do(opcode, inputs?, fields?)` / `Scratch.get<T>(opcode, inputs?, fields?)`. Opcode typos are not validated — the VM just ignores your block, same as hand-written extensions.

`@warp` / `@noWarp` on a **method** set the generated procedure's warp flag. Warp changes scheduling, not just speed, so it is opt-in; TS6 forbids `@warp function`, hence methods. `Scratch.waitUntil` inside a warp method is `TSCR3005` because warp never yields.

`==`/`!=` on two static `string`s are case-sensitive: `operator_equals` acts as a gate, then a 53-costume probe distinguishes ASCII letter case. Non-ASCII case folds (`É`/`é`) remain a documented limit. Cross-type comparisons follow the Value ABI `abstractEquals()` contract. `===` is strict and warns on cross-type operands.

`try`/`catch` and `throw "string"` lower to typed failures and run in the interpreter. Native Scratch has no try/catch primitive, so those projects get `TSCR3001` — the compiler declines to pretend the envelope arrived. `async`/`await`, generators, promises, closures, `eval`, dynamic imports, arbitrary npm, DOM and Node APIs are not supported.

## CLI

| Command | Description |
| --- | --- |
| `typescratch init [path]` | Scaffold the default workspace |
| `typescratch build` | Compile and write outputs |
| `typescratch check` | Validate without writing files |
| `typescratch explain` | Print the lowering plan |

Flags: `--entry`, `--config`, `--target scratch|turbowarp`, `--abi-profile native|extension|auto`, `--out`.

`--abi-profile` is who you'd *prefer* to implement the ABI; it is orthogonal to `--target`. Asking official Scratch to load a custom extension is optimism, not a build (`TSCR5001`). On TurboWarp, `extension` is mixed: Frame storage goes to an Extension `Map<callId, CallFrame>`, Call/CFG/Memory/Dispatch stay Native, and the report says exactly who did what. `auto` resolves to `native` — nobody gets elected on zero promises.

Frame storage is tombstoned, not deleted: the caller reads its return value *after* the callee's epilogue, so deleting the frame there would be like throwing away the envelope while delivering the letter. Orphans from stopped scripts accumulate until worker restart; `--abi-frame-orphan-limit N` makes the ninth orphan fail loudly. Extension recursion is refused (`TSCR3002`) because async frame reads shuffle the procedure stack — a recursive factorial would confidently answer `1`. Native recursion answers `120`.

A build writes the `.sb3`, a readable `*.project.json`, a build report, a source map, and for TurboWarp the extension JS as a data URL. Custom extensions cannot be uploaded to the official Scratch site; the report says so every time.

Codes: `TSCR1xxx` frontend, `2xxx` language subset, `3xxx` lowering, `4xxx` ABI, `5xxx` compatibility, `6xxx` performance.

## How it works

```text
TypeScript → typed AST → HIR → control-flow lowering → ir-opt → backend planner
  → native lowering    → project graph → SB3 exporter
  → extension lowering → TurboWarp JS
```

Sixteen packages, one pnpm workspace. Three boundaries: the TS AST is not IR, the IR knows nothing about Scratch JSON, exporters only handle format. TypeScript is pinned to 6.0.3 and only `frontend-ts` imports it; if TS 7 ships a stable API, one package cares.

```bash
pnpm build:showcase   # dist/showcase.sb3 — the full language demo
pnpm trace:showcase   # per-frame VM state changes for 3 green flags
pnpm snapshots:update # refresh five golden artifacts per case
```

193 Vitest tests plus 23 headless VM conformance runs compare SAY/variable/list traces against an independent IR interpreter. Five golden artifacts are pinned for ten cases; CI runs the gate on Node 24 and 26. `pnpm verify:e2e` is a separate browser-and-network gate that loads `dist/hybrid.sb3` in the real TurboWarp editor and asserts the embedded extension actually executes.

## License

MIT. See [LICENSE](LICENSE).
