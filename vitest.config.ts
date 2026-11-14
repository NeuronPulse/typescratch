import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const packages = readdirSync(new URL("./packages", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const alias: Record<string, string> = {
  "@typescratch/runtime": `${root}packages/language/runtime.d.ts`,
};
for (const name of packages) {
  alias[`@typescratch/${name}`] = `${root}packages/${name}/src/index.ts`;
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    testTimeout: 60_000,
  },
});
