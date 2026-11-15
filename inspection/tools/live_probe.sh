#!/bin/bash
# Live probe of the baseline COPY over HTTP with curl. Disposable stores only.
# Usage: live_probe.sh <base-url> <python> <summarize.py> <scratch-dir>
set -u
BASE="$1"; PY="$2"; SUM="$3"; SCRATCH="$4"
OUT="$SCRATCH/probe-response.json"
HDR="$SCRATCH/probe-headers.txt"

# req <summary-mode> <method> <path> [json-body] [extra curl args...]
req() {
  local mode="$1" method="$2" path="$3" body="${4:-}"
  shift 3; [ $# -gt 0 ] && shift
  local shown="curl -s -X $method '$BASE$path'"
  [ -n "$body" ] && shown="$shown -H 'Content-Type: application/json' -d '${body:0:240}'"
  [ $# -gt 0 ] && shown="$shown $*"
  echo
  echo "\$ $shown"
  local code
  if [ -n "$body" ]; then
    code=$(curl -s -o "$OUT" -D "$HDR" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' "$@" -d "$body" "$BASE$path")
  else
    code=$(curl -s -o "$OUT" -D "$HDR" -w '%{http_code}' -X "$method" "$@" "$BASE$path")
  fi
  echo "  HTTP $code"
  LAST_CODE="$code"
  [ "$mode" = "none" ] || "$PY" -B "$SUM" "$mode" "$OUT" ${EXTRA:-}
}
field() { "$PY" -B "$SUM" "field:$1" "$OUT"; }
section() { echo; echo "================ $* ================"; }

section "1. Health, aircraft list, static shell, response headers"
req raw GET /api/health
req raw GET /api/aircraft
req none GET /
echo "  index.html bytes=$(wc -c < "$OUT" | tr -d ' ')"
grep -i -E '^(cache-control|x-content-type-options|content-type|content-security-policy|x-frame-options):' "$HDR" | sed 's/^/  header: /' | tr -d '\r'
req none GET /vendor/THREE-LICENSE.txt
echo "  first line: $(head -1 "$OUT")"
req none GET /vendor/three.core.js
echo "  three.core.js bytes=$(wc -c < "$OUT" | tr -d ' ')"
grep -i -E '^(content-encoding|content-length|cache-control):' "$HDR" | sed 's/^/  header: /' | tr -d '\r'

section "2. Lookups requested by the task"
EXTRA="P-ELR-A-CUSHION P-STD-A-CUSHION P-EXIT-B-CUSHION P-CARPET-KIT P-FORWARD-PANEL P-BIN-L-01" req lookup GET "/api/lookup?tail=N100TL&check_date=2026-11-12"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N200TL&check_date=2026-06-30"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N200TL&check_date=2026-07-01"
EXTRA="P-EXIT-B-CUSHION P-CARPET-KIT" req lookup GET "/api/lookup?tail=N300TL&check_date=2026-11-12"
req lookup GET "/api/lookup?tail=N000TL&check_date=2026-11-12"
req lookup GET "/api/lookup?tail=N110TL&check_date=2026-11-12"
req lookup GET "/api/lookup?tail=N999ZZ&check_date=2026-11-12"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N100TL&check_date=2027-01-01"

section "3. Extra boundary and layout lookups"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N100TL&check_date=2026-12-31"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N100TL&check_date=2025-07-21"
req lookup GET "/api/lookup?tail=N100TL&check_date=2025-09-30"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N100TL&check_date=2025-10-01"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N010TL&check_date=2025-07-21"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N010TL&check_date=2025-07-22"
req lookup GET "/api/lookup?tail=N030TL&check_date=2026-11-12"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N040TL&check_date=2026-06-30"
EXTRA="P-CARPET-KIT" req lookup GET "/api/lookup?tail=N040TL&check_date=2026-07-01"
req lookup GET "/api/lookup?tail=N050TL&check_date=2026-11-12"
EXTRA="P-EXIT-B-CUSHION" req lookup GET "/api/lookup?tail=N090TL&check_date=2026-11-12"
req lookup GET "/api/lookup?tail=N010TL&check_date=2023-12-31"
req lookup GET "/api/lookup?tail=%20n100tl%20&check_date=2026-11-12"
req raw GET "/api/lookup?tail=N100TL&check_date=bad"
req raw GET "/api/lookup?tail=N100TL"
req raw GET "/api/lookup?tail=N100TL&check_date=2026-02-30"

section "4. Visit A: N100TL 2026-11-12, 3A cushion + full-cabin carpet substitute kit"
req visit POST /api/visits '{"tail":"N100TL","check_date":"2026-11-12","technician":"Probe Tech"}'
VA=$(field id); echo "  -> visit A id=$VA"
req visit PUT "/api/visits/$VA/replacements" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1,"note":"probe: 3A cushion"}'
req visit PUT "/api/visits/$VA/replacements" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1,"note":"probe: 3A cushion recorded again (upsert)"}'
req visit PUT "/api/visits/$VA/replacements" '{"location":"FULL_CABIN","rule_id":"R-V01-P-CARPET-KIT","quantity":1,"note":"probe: primary carpet kit"}'
req visit PUT "/api/visits/$VA/replacements" '{"location":"FULL_CABIN","rule_id":"R-V01-P-CARPET-KIT","substitute_id":"SUB-KIT-1","quantity":1,"note":"probe: substitute kit replaces primary"}'
req report GET "/api/visits/$VA/report"

section "5. Visit B: empty completion, forged input"
req visit POST /api/visits '{"tail":"N100TL","check_date":"2026-11-12"}'
VB=$(field id); echo "  -> visit B id=$VB"
req raw POST "/api/visits/$VB/complete"
PUTB="/api/visits/$VB/replacements"
req raw PUT "$PUTB" '{"location":"3B","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1}'
req raw PUT "$PUTB" '{"location":"99Z","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1}'
req raw PUT "$PUTB" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":2}'
req raw PUT "$PUTB" '{"location":"3A","rule_id":"R-V02-P-ELR-A-CUSHION","quantity":1}'
req raw PUT "$PUTB" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","substitute_id":"SUB-KIT-1","quantity":1}'
req raw PUT "$PUTB" '{"location":"14B","rule_id":"R-V01-P-EXIT-B-CUSHION","quantity":1}'
req raw PUT "$PUTB" '{"location":"14A","rule_id":"R-V01-P-STD-A-CUSHION","quantity":1}'
req raw PUT "$PUTB" '{"location":"BIN-L-02","rule_id":"R-V01-P-BIN-L-01","quantity":1}'
req raw PUT "$PUTB" '{"location":"FORWARD","rule_id":"R-V01-P-CARPET-KIT","quantity":1}'
req raw PUT "$PUTB" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":"1"}'
req raw PUT "$PUTB" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1,"note":"'"$(printf 'x%.0s' $(seq 1 1001))"'"}'
req raw PUT "$PUTB" '{"location":"3A"}'
req raw PUT "$PUTB" 'not json'
echo "  -- quantity on non-seat locations (pydantic allows 1..100; only seats are forced to 1) --"
req visit PUT "$PUTB" '{"location":"BIN-L-01","rule_id":"R-V01-P-BIN-L-01","quantity":100,"note":"forged: 100 doors for one bin module"}'
req visit PUT "$PUTB" '{"location":"FULL_CABIN","rule_id":"R-V01-P-CARPET-KIT","substitute_id":"SUB-KIT-1","quantity":7,"note":"forged: 7 full-cabin kits","part_no":"EVIL-PART","parts":[{"part_no":"EVIL","qty":9,"unit":"EA"}],"status":"COMPLETED"}'
req report GET "/api/visits/$VB/report"
ITEMB=$("$PY" -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["replacements"][0]["id"])' "$OUT")
echo "  -- cross-visit delete: item of visit B addressed through visit A --"
req raw DELETE "/api/visits/$VA/replacements/$ITEMB"
req raw DELETE "/api/visits/$VB/replacements/does-not-exist"
req visit DELETE "/api/visits/$VB/replacements/$ITEMB"
echo "  -- visit creation refusals and input validation --"
req raw POST /api/visits '{"tail":"N000TL","check_date":"2026-11-12"}'
req raw POST /api/visits '{"tail":"N110TL","check_date":"2026-11-12"}'
req raw POST /api/visits '{"tail":"N999ZZ","check_date":"2026-11-12"}'
req raw POST /api/visits '{"tail":"N100TL; DROP","check_date":"2026-11-12"}'
req raw POST /api/visits '{"tail":"N100TL","check_date":"2026-11-12","technician":"'"$(printf 'T%.0s' $(seq 1 81))"'"}'
req raw POST /api/visits '{"tail":"N100TL","check_date":"2026-11-12"}' -H 'Origin: https://unrelated.example'
req raw POST /api/visits '{"tail":"N100TL","check_date":"2026-11-12"}' -H 'Origin: null'
req raw GET /api/visits/missing
req raw GET /api/visits/missing/report

section "6. Completion, locking, idempotent completion (visit A)"
req report POST "/api/visits/$VA/complete"
DONE1=$(field completed_at)
ITEMA=$("$PY" -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["replacements"][0]["id"])' "$OUT")
req raw PUT "/api/visits/$VA/replacements" '{"location":"3A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1,"note":"edit after completion"}'
req raw PUT "/api/visits/$VA/replacements" '{"location":"4A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1,"note":"add after completion"}'
req raw DELETE "/api/visits/$VA/replacements/$ITEMA"
req none POST "/api/visits/$VA/complete"
DONE2=$(field completed_at)
echo "  second complete: status=$(field status) completed_at unchanged=$([ "$DONE1" = "$DONE2" ] && echo yes || echo no) ($DONE1)"
req report GET "/api/visits/$VA/report"

section "7. History listing"
req list GET /api/visits

section "8. Concurrency: 12 parallel upserts of the same seat/component on visit B (no version / If-Match exists)"
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" -X PUT -H 'Content-Type: application/json' \
    -d '{"location":"5A","rule_id":"R-V01-P-ELR-A-CUSHION","quantity":1,"note":"writer '"$i"'"}' "$BASE$PUTB" &
done | sort | uniq -c | sed 's/^/  parallel PUT status counts: /'
wait
req visit GET "/api/visits/$VB"
echo "  -- parallel complete + edit on visit B --"
( curl -s -o /dev/null -w "complete -> %{http_code}\n" -X POST "$BASE/api/visits/$VB/complete" &
  curl -s -o /dev/null -w "edit     -> %{http_code}\n" -X PUT -H 'Content-Type: application/json' \
    -d '{"location":"6A","rule_id":"R-V01-P-STD-A-CUSHION","quantity":1,"note":"racing edit"}' "$BASE$PUTB" &
  wait ) | sort | sed 's/^/  /'
req visit GET "/api/visits/$VB"

section "9. API docs endpoints"
req none GET /openapi.json
echo "  openapi paths: $("$PY" -B -c 'import json,sys; print(sorted(json.load(open(sys.argv[1]))["paths"]))' "$OUT")"
req none GET /docs
echo "  external hosts referenced by /docs: $(grep -o 'https://[^/"]*' "$OUT" | sort -u | tr '\n' ' ')"

rm -f "$OUT" "$HDR"
echo
echo "probe finished"
