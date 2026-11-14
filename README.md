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
pnpm test          # 32 tests
pnpm build         # dist/hello.sb3
pnpm build:default # dist/default.sb3
pnpm build:hybrid  # dist/hybrid.sb3 (TurboWarp)
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

Flags: `--entry <file>`, `--config <file>`, `--target scratch|turbowarp`, `--out <file>`.

A build writes the `.sb3`, a readable `*.project.json`, a build report, a source map, and for TurboWarp targets the generated extension JS and an embedding manifest.

## 5. Language subset

Supported: `number`, `string`, `boolean`, `let`/`const`, assignment and compound assignment, unary and binary operators, `if/else`, `while`, restricted `for`, template strings, `Scratch.onFlag/say/wait/move/hide/show`, `Scratch.global/local` with `get/set/change`, and the native Math functions. APIs are resolved by symbol, so `import { Scratch as S }` works too.

Not supported: classes, promises, `async`/`await`, generators, `eval`, dynamic imports, closures, recursion, arbitrary npm packages, DOM and Node APIs.

TypeScratch does not silently change semantics. Cross-type equality (Scratch considers `"10"` and `10` close friends), the difference between JS `%` and Scratch `mod`, and booleans stored as `"true"` strings are all reported rather than guessed.

| Code | Area |
| --- | --- |
| `TSCR1xxx` | TypeScript frontend |
| `TSCR2xxx` | Language subset |
| `TSCR3xxx` | Lowering |
| `TSCR4xxx` | Runtime ABI |
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
TypeScript → typed AST → HIR → backend planner
  → native lowering    → project graph → SB3 exporter
  → extension lowering → TurboWarp JS
```

Fourteen packages in a pnpm workspace: `language`, `diagnostics`, `ir`, `runtime-abi`, `frontend-ts`, `workspace`, `backend-planner`, `backend-native`, `backend-turbowarp`, `graph`, `exporter-sb3`, `exporter-turbowarp`, `compiler`, `cli`.

Three boundaries: TS AST is not IR, IR knows nothing about Scratch JSON, exporters only handle format. The TypeScript Compiler API is pinned to 6.0.3 and used only in `frontend-ts`. If TypeScript 7 ever ships a stable API, only one package has to care.

## 8. Development

```bash
pnpm typecheck
pnpm lint
pnpm test
```

32 tests cover HIR lowering, block graph integrity, deterministic output, extension embedding, workspace roles and default assets. Some tests call the real `scratch-vm` deserializer to verify shadow blocks and extension IDs. `pnpm verify:vm` is optional: headless `scratch-vm` needs a DOM and skips when none is present.

## License

MIT. See [LICENSE](LICENSE).
