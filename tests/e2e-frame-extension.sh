#!/usr/bin/env bash
# Route A E2E: run function examples with --abi-profile extension in the real
# TurboWarp editor and assert the same SAY traces as the headless VM.
# Requires playwright-cli + Chrome + network. Not part of `pnpm verify`.
set -euo pipefail
cd "$(dirname "$0")/.."

run_case() {
  local example="$1" expected="$2" trigger="$3"
  pnpm typescratch build --entry "examples/$example/main.ts" --target turbowarp \
    --abi-profile extension --out "dist/ext-$example.sb3" >/dev/null 2>&1
  local url
  url=$(python3 - "dist/ext-$example.sb3" <<'PY'
import base64, sys, urllib.parse
data = base64.b64encode(open(sys.argv[1], "rb").read()).decode()
print("https://turbowarp.org/editor/?project_url=" + urllib.parse.quote("data:application/octet-stream;base64," + data, safe=""))
PY
)
  playwright-cli close-all >/dev/null 2>&1 || true
  playwright-cli open --browser=chrome "$url" >/dev/null 2>&1
  sleep 11
  local code
  if [ "$trigger" = "space" ]; then
    code="async page => { const n=await page.getByRole('button',{name:'允许'}).count(); if(n) await page.getByRole('button',{name:'允许'}).click(); await page.waitForTimeout(1800); await page.evaluate(() => { window.__sayLog=[]; window.vm.runtime.on('SAY',(t,ty,x)=>window.__sayLog.push(String(x))); }); await page.locator('img[class*=green-flag]').click(); await page.waitForTimeout(600); await page.keyboard.press('Space'); await page.waitForTimeout(1800); return await page.evaluate(() => window.__sayLog); }"
  else
    code="async page => { const n=await page.getByRole('button',{name:'允许'}).count(); if(n) await page.getByRole('button',{name:'允许'}).click(); await page.waitForTimeout(1800); await page.evaluate(() => { window.__sayLog=[]; window.vm.runtime.on('SAY',(t,ty,x)=>window.__sayLog.push(String(x))); }); await page.locator('img[class*=green-flag]').click(); await page.waitForTimeout(1800); return await page.evaluate(() => window.__sayLog); }"
  fi
  local result
  result=$(playwright-cli run-code "$code" 2>/dev/null | grep -A1 '### Result' | tail -n 1)
  echo "$example: $result"
  if ! echo "$result" | grep -q "$expected"; then
    echo "FAILED $example: expected $expected" >&2
    return 1
  fi
}

trap 'playwright-cli close-all >/dev/null 2>&1 || true' EXIT
run_case "function-return" "42" "flag"
run_case "function-nested" "8" "flag"
run_case "function-reentrant" "14" "space"
echo "Extension frame E2E ok"
