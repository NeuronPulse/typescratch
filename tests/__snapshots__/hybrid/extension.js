(function (Scratch) {
  'use strict';
  class TypeScratchGenerated {
    getInfo() {
      return {
        id: "tscr4995f9dafc31",
        name: 'TypeScratch generated',
        blocks: [
          {
            opcode: "tscr_intrinsic_math_hypot",
            blockType: Scratch.BlockType.REPORTER,
            text: "hypot [A] [B]",
            arguments: { A: { type: Scratch.ArgumentType.NUMBER }, B: { type: Scratch.ArgumentType.NUMBER } }
          },
          {
            opcode: "tscr_intrinsic_string_upper",
            blockType: Scratch.BlockType.REPORTER,
            text: "uppercase [A]",
            arguments: { A: { type: Scratch.ArgumentType.STRING } }
          }
        ]
      };
    }
    tscr_intrinsic_math_hypot(args) {
      try {
        const A = Number(args.A);
        const B = Number(args.B);
        if (![A, B].every(Number.isFinite)) return 0;
        return Math.hypot(A, B);
      } catch {
        return 0;
      }
    }
    tscr_intrinsic_string_upper(args) {
      try {
        const A = String(args.A);
        return String(A).toUpperCase();
      } catch {
        return "";
      }
    }
  }
  Scratch.extensions.register(new TypeScratchGenerated());
})(Scratch);
