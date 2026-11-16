#!/usr/bin/env bash
# A② TurboWarp E2E. Loads an sb3 through TurboWarp's ?project_url=data: loader,
# authorizes the embedded extension from extensionURLs, runs the green flag and
# asserts the SAY events. Requires `playwright-cli` on PATH and Chrome installed.
# Not part of `pnpm verify` — browsers are an optional, network-dependent gate.
set -euo pipefail
cd "$(dirname "$0")/.."

SB3="${1:-dist/hybrid.sb3}"
if [ ! -f "$SB3" ]; then
  echo "missing sb3: $SB3" >&2
  exit 1
fi

URL=$(python3 - "$SB3" <<'PY'
import base64, sys, urllib.parse
data = base64.b64encode(open(sys.argv[1], "rb").read()).decode()
url = "data:application/octet-stream;base64," + data
print("https://turbowarp.org/editor/?project_url=" + urllib.parse.quote(url, safe=""))
PY
)

playwright-cli close-all >/dev/null 2>&1 || true
playwright-cli open --browser=chrome "$URL" >/dev/null 2>&1
trap 'playwright-cli close-all >/dev/null 2>&1 || true' EXIT

# TurboWarp asks before running a project that declares a custom extension.
authorized=0
for _ in $(seq 1 40); do
  if playwright-cli run-code "async page => await page.getByRole('button', {name:'允许'}).count()" 2>/dev/null | grep -A1 '### Result' | tail -n 1 | grep -qx '1'; then
    playwright-cli run-code "async page => { await page.getByRole('button', {name:'允许'}).click(); return 'authorized'; }" >/dev/null 2>&1
    authorized=1
    break
  fi
  sleep 1
done
if [ "$authorized" -ne 1 ]; then
  echo "extension security dialog did not appear" >&2
  playwright-cli snapshot >/dev/null 2>&1 || true
  exit 1
fi
sleep 3

# Block palette must now expose the extension's reporters.
palette=$(playwright-cli run-code "async page => await page.evaluate(() => document.body.textContent)" 2>/dev/null || true)
for opcode in hypot uppercase; do
  echo "$palette" | grep -q "$opcode" || { echo "extension opcode $opcode missing from palette" >&2; exit 1; }
done

result=$(playwright-cli run-code "async page => {
  await page.evaluate(() => {
    window.__sayLog = [];
    window.vm.runtime.on('SAY', (t, ty, text) => window.__sayLog.push(String(text)));
  });
  await page.locator('img[class*=green-flag]').click();
  await page.waitForTimeout(2000);
  return await page.evaluate(() => [...new Set(window.__sayLog)]);
}" 2>/dev/null)

echo "$result"
for expected in 5 HELLO 2; do
  echo "$result" | grep -q "\"$expected\"" || { echo "missing SAY $expected" >&2; exit 1; }
done
echo "TurboWarp E2E ok: extension data URL loaded, reporters executed, SAY 5 / HELLO / 2"
