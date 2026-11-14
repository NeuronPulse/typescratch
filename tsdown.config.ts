import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["packages/cli/src/bin.ts"],
  outDir: "dist/cli",
  format: "esm",
  platform: "node",
  dts: false,
  clean: true,
  deps: { neverBundle: ["typescript", "fflate"] },
});
