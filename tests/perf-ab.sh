#!/usr/bin/env bash
# Controlled A/B: Native frame lists vs Extension frame Map in real TurboWarp.
# Same SAY/call count/depth, same editor, same sandbox. Cold start (first 3
# flags) and steady state (median of next 17) recorded separately.
# `performance.now` is unavailable in playwright-cli's run-code sandbox, so
# wall time is measured with Date.now around the whole loop (ms precision).
set -uo pipefail
cd "$(dirname "$0")/.."

MEASURE_CODE="async page => { await page.evaluate(() => { window.__perf = { ticks: 0 }; const vm = window.vm; const orig = vm.runtime._step; vm.runtime._step = function(){ window.__perf.ticks++; return orig.apply(this, arguments); }; }); const flag = page.locator('img[class*=green-flag]'); const out = []; const t0 = Date.now(); for (let i = 0; i < 20; i++) { await page.evaluate(() => { window.__perf.ticks = 0; }); await flag.click(); await page.waitForTimeout(100); out.push(await page.evaluate(() => window.__perf.ticks)); } return JSON.stringify({ ticks: out, wallMsTotal: Date.now() - t0 }); }"

measure() {
  local entry="$1" profile="$2" out="dist/perf-$entry-$profile.sb3"
  pnpm typescratch build --entry "examples/$entry/main.ts" --target turbowarp \
    --abi-profile "$profile" --out "$out" >/dev/null 2>&1 || { echo '{}'; return; }
  local url
  url=$(python3 - "$out" <<'PY'
import base64, sys, urllib.parse
data = base64.b64encode(open(sys.argv[1], "rb").read()).decode()
print("https://turbowarp.org/editor/?project_url=" + urllib.parse.quote("data:application/octet-stream;base64," + data, safe=""))
PY
)
  playwright-cli close-all >/dev/null 2>&1 || true
  playwright-cli open --browser=chrome "$url" >/dev/null 2>&1 || { echo '{}'; return; }
  sleep 14
  playwright-cli run-code "async page => { const n=await page.getByRole('button',{name:'允许'}).count(); if(n) await page.getByRole('button',{name:'允许'}).click(); return 'ok'; }" >/dev/null 2>&1
  sleep 3
  local result
  result=$(playwright-cli run-code "$MEASURE_CODE" 2>/dev/null | grep -A1 '### Result' | tail -n 1 | tr -d '\r')
  [ -n "$result" ] && echo "$result" || echo '{}'
}

echo "{"
first=1
for entry in function-return function-nested; do
  for profile in native extension; do
    row=$(measure "$entry" "$profile")
    [ $first -eq 0 ] && echo ","
    first=0
    printf '  "%s-%s": %s' "$entry" "$profile" "$row"
  done
done
echo
echo "}"
playwright-cli close-all >/dev/null 2>&1 || true
