import { compareGolden, GOLDEN_ARTIFACTS, GOLDEN_CASES, updateGolden } from "./golden.ts";
import { ROOT } from "./helpers.ts";

const update = process.argv.includes("--update");
if (update) {
  for (const file of updateGolden(ROOT)) console.log(`updated ${file}`);
  console.log(`wrote ${GOLDEN_CASES.length * GOLDEN_ARTIFACTS.length} golden artifacts`);
} else {
  const diffs = compareGolden(ROOT);
  if (diffs.length > 0) {
    for (const diff of diffs) console.error(`golden ${diff}`);
    console.error("run pnpm snapshots:update to refresh the snapshots");
    process.exit(1);
  }
  console.log(`golden snapshots ok: ${GOLDEN_CASES.length} cases x ${GOLDEN_ARTIFACTS.length} artifacts`);
}
process.exit(0);
