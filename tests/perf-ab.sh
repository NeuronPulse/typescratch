#!/usr/bin/env bash
# Controlled A/B: Native frame lists vs Extension frame Map in real TurboWarp.
# Same SAY/call count/depth, same editor, same sandbox. Cold start (first 3
# flags) and steady state (median of next 17) recorded separately.
# `performance.now` is unavailable in playwright-cli's run-code sandbox, so
# wall time is measured with Date.now around the whole loop (ms precision).
#
# Load path (IMPORTANT, recorded in the experiment report):
#   - function-return native/extension, function-nested extension:
#     ?project_url=data:... — the same loader the E2E harness uses, so the
#     Extension security dialog appears and is authorized before measuring.
#   - function-nested native ONLY: synthetic drop of the sb3 File. Its data
#     URL is 12,371 chars and TurboWarp's loader silently rejects it. This
#     project declares NO extension, so there is no authorization path to
#     skip; SAY output was verified separately. The measurement starts only
#     after the project is loaded, so the load mechanism is not timed.
set -uo pipefail
cd "$(dirname "$0")/.."

MEASURE_CODE="async page => { await page.evaluate(() => { window.__perf = { ticks: 0 }; const vm = window.vm; const orig = vm.runtime._step; vm.runtime._step = function(){ window.__perf.ticks++; return orig.apply(this, arguments); }; }); const flag = page.locator('img[class*=green-flag]'); const out = []; const t0 = Date.now(); for (let i = 0; i < 20; i++) { await page.evaluate(() => { window.__perf.ticks = 0; }); await flag.click(); await page.waitForTimeout(100); out.push(await page.evaluate(() => window.__perf.ticks)); } return JSON.stringify({ ticks: out, wallMsTotal: Date.now() - t0 }); }"

measure() {
  local entry="$1" profile="$2" out="dist/perf-$entry-$profile.sb3"
  pnpm typescratch build --entry "examples/$entry/main.ts" --target turbowarp \
    --abi-profile "$profile" --out "$out" >/dev/null 2>&1 || { echo '{}'; return; }
  playwright-cli close-all >/dev/null 2>&1 || true
  if [ "$entry" = "function-nested" ] && [ "$profile" = "native" ]; then
    local b64
    b64=$(python3 -c "import base64; print(base64.b64encode(open('$out','rb').read()).decode())")
    playwright-cli open --browser=chrome 'https://turbowarp.org/editor/' >/dev/null 2>&1 || { echo '{}'; return; }
    sleep 8
    playwright-cli run-code "async page => { const b64='$b64'; await page.evaluate((s) => { const bin=atob(s); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i); const f=new File([arr],'project.sb3',{type:'application/octet-stream'}); const dt=new DataTransfer(); dt.items.add(f); document.body.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})); }, b64); return 'ok'; }" >/dev/null 2>&1 || { echo '{}'; return; }
    sleep 8
  else
    local url
    url=$(python3 - "$out" <<'PY'
import base64, sys, urllib.parse
data = base64.b64encode(open(sys.argv[1], "rb").read()).decode()
print("https://turbowarp.org/editor/?project_url=" + urllib.parse.quote("data:application/octet-stream;base64," + data, safe=""))
PY
)
    playwright-cli open --browser=chrome "$url" >/dev/null 2>&1 || { echo '{}'; return; }
    sleep 14
    if [ "$profile" = "extension" ]; then
      local authorized=0
      for _ in $(seq 1 20); do
        local n
        n=$(playwright-cli run-code "async page => await page.getByRole('button',{name:'允许'}).count()" 2>&1 | grep -A1 '### Result' | tail -1 | tr -d '\r')
        if [ "$n" = "1" ]; then
          playwright-cli run-code "async page => { await page.getByRole('button',{name:'允许'}).click(); return 'ok'; }" >/dev/null 2>&1
          authorized=1
          break
        fi
        sleep 1
      done
      [ "$authorized" -eq 1 ] || { echo '{}'; return; }
      sleep 3
    else
      sleep 3
    fi
  fi
  local result
  result=$(playwright-cli run-code "$MEASURE_CODE" 2>&1 | grep -A1 '### Result' | tail -n 1 | tr -d '\r')
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
