#!/usr/bin/env bash
# The three probes that were never run, plus the latency/concurrency measurement.
#
#   AB_URL='https://<agent-builder-host>/api/v1/run/<flow-id>' \
#   AB_KEY='<x-api-key>' \
#     ./run-gaps.sh            # everything
#     ./run-gaps.sh size       # P1 — the payload ceiling. Run this one first.
#     ./run-gaps.sh session    # P3 — is the flow's memory actually off?
#     ./run-gaps.sh failure    # P4 — what does a failure look like?
#     ./run-gaps.sh load       # P4 — latency spread and concurrency
#
# Unlike run.sh, this one DOES parse: each check prints a verdict, because the answers
# decide whether `LLM_API_FORMAT=agent-builder` is safe to point at real incidents. Raw
# bodies are still saved under gap-responses/ so nothing is hidden behind the verdict.
set -euo pipefail

: "${AB_URL:?set AB_URL to the full /api/v1/run/<flow-id> URL}"
: "${AB_KEY:?set AB_KEY to the x-api-key value}"
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

dir="$(cd "$(dirname "$0")" && pwd)"
out="$dir/gap-responses"
mkdir -p "$out"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '       %s\n' "$*"; }

# post <payload-file> <session-id> <save-name> [api-key] [url]
# Sets STATUS, ELAPSED, REPLY, ERRFLAG. Never aborts on a bad response — a failure IS a
# result here, and `set -e` killing the run would throw away the finding.
post() {
  local file="$1" session="$2" name="$3" key="${4:-$AB_KEY}" url="${5:-$AB_URL}"
  local body start
  body=$(jq -Rs --arg s "$session" \
    '{input_type:"chat",output_type:"chat",input_value:.,session_id:$s}' <"$file")
  start=$(date +%s)
  STATUS=$(curl -sS -o "$out/$name.json" -w '%{http_code}' --max-time 600 \
    --request POST --url "$url" \
    --header 'Content-Type: application/json' \
    --header "x-api-key: $key" \
    --data "$body" 2>/dev/null || echo "000")
  ELAPSED=$(( $(date +%s) - start ))
  REPLY=$(jq -re '.outputs[0].outputs[0].results.message.text' "$out/$name.json" 2>/dev/null || echo "")
  ERRFLAG=$(jq -r '.outputs[0].outputs[0].results.message.error // "absent"' "$out/$name.json" 2>/dev/null || echo "absent")
}

# ---------------------------------------------------------------------------------------
# P1 — the payload ceiling
#
# The dangerous answer is not an error, it is silence: a platform that quietly drops the
# tail of an oversized payload hands back a confident RCA built on half the evidence, and
# nothing in the response says so. Response length cannot reveal it. So the payload ends
# with a token the model can only echo if it actually received the last byte.
# ---------------------------------------------------------------------------------------

# Realistic filler, not lorem ipsum: PromQL label braces, JSON braces, double quotes and
# backticks are exactly the characters a Langflow prompt component might eat.
read -r -d '' EVIDENCE_BLOCK <<'BLOCK' || true
[k8s_describe_pod payment/payment-api-7d9f6c4b8-xk2p9]
Status: Running   Node: worker-3   Image: `registry.internal/payment-api:2.14.3`
  api: Limits{memory: 512Mi, cpu: 500m}  Requests{memory: 256Mi, cpu: 200m}
  Last State: Terminated   Reason: OOMKilled   Exit Code: 137   Restart Count: 7

[prometheus_query_range container_memory_working_set_bytes{namespace="payment",pod=~"payment-api.*"}]
2026-08-22T06:30:00Z  211Mi
2026-08-22T06:44:00Z  349Mi
2026-08-22T06:47:00Z  511Mi

[loki_query_range {namespace="payment",container="api"} |= "error"]
2026-08-22T06:47:11Z ERROR runtime: out of memory: cannot allocate 32MB
{"level":"error","msg":"fatal error: runtime: out of memory","batch":{"rows":50000}}
BLOCK

make_size_payload() {
  local kb="$1" token="$2" file="$3"
  local target=$(( kb * 1024 ))

  cat >"$file" <<HEAD
You are a DevOps incident investigator reading collected evidence.

The VERY LAST line of this message begins with END-TOKEN. Reply with ONLY the token that
follows it — no prose, no punctuation, nothing else. If this message has no END-TOKEN
line, reply with exactly MISSING.

=== Collected evidence ===

HEAD

  # ponytail: wc -c per iteration is O(n^2), which at 32 KB is ~70 rounds of a stat call.
  # Counting bytes up front would be faster and less obvious; this stays as long as the
  # ladder tops out in the tens of KB.
  local n=0
  while [ "$(wc -c <"$file")" -lt "$target" ]; do
    n=$(( n + 1 ))
    printf -- '--- evidence chunk %d ---\n%s\n\n' "$n" "$EVIDENCE_BLOCK" >>"$file"
  done

  printf 'END-TOKEN: %s\n' "$token" >>"$file"
}

probe_size() {
  bold "P1 — payload ceiling (silent truncation is the blocker)"
  note "Largest payload ever sent to this flow was 6 KB. Real round-5 transcripts reach 20 KB."
  local truncated=0

  for kb in 4 8 16 24 32; do
    local token file bytes
    token="ZULU-$kb-$RANDOM"
    file="$out/size-${kb}kb.txt"
    make_size_payload "$kb" "$token" "$file"
    bytes=$(wc -c <"$file" | tr -d ' ')

    post "$file" "gap-size-${kb}kb-$$" "size-${kb}kb"

    if [ "$STATUS" != "200" ]; then
      fail "${kb}KB (${bytes}B) — HTTP $STATUS in ${ELAPSED}s"
      note "A ceiling that ERRORS is the safe answer: the worker sees a non-2xx and reports it."
      note "Record this status as the hard limit and keep transcripts below it."
      break
    elif printf '%s' "$REPLY" | grep -qF "$token"; then
      pass "${kb}KB (${bytes}B) in ${ELAPSED}s — tail token came back, nothing was dropped"
    else
      truncated=1
      fail "${kb}KB (${bytes}B) in ${ELAPSED}s — tail token did NOT come back"
      note "reply was: $(printf '%s' "$REPLY" | head -c 120)"
      note ">>> SILENT TRUNCATION at ~${bytes}B. This is a BLOCKER: an RCA would be built"
      note ">>> on partial evidence with no error to catch. Cap the transcript below this,"
      note ">>> or move the protocol + catalog into the flow's own prompt to buy headroom."
      break
    fi
  done

  if [ "$truncated" -eq 0 ]; then
    note "No truncation found up to the sizes tested."
  fi
  # Every probe returns 0 even when its verdict is FAIL. A finding is a result, not a script
  # error — without this, `set -e` aborts `all` mode exactly when the worst news arrives and
  # the remaining probes never run.
  return 0
}

# ---------------------------------------------------------------------------------------
# P3 — is the flow's memory actually off?
#
# The earlier run only proved that two DIFFERENT session ids do not leak. That is also what
# a flow with no memory at all looks like, so it proved nothing about memory. The deciding
# case — same session id, twice — was never run.
# ---------------------------------------------------------------------------------------
probe_session() {
  bold "P3 — session isolation and flow memory"

  local shared="gap-shared-$$"
  post "$dir/p3-session-a.txt" "$shared" "session-shared-a"
  note "same session, call A (store the token): $REPLY"
  post "$dir/p3-session-b.txt" "$shared" "session-shared-b"
  local same="$REPLY"
  note "same session, call B (recall it):      $same"

  post "$dir/p3-session-a.txt" "gap-one-$$" "session-diff-a"
  post "$dir/p3-session-b.txt" "gap-two-$$" "session-diff-b"
  local diff="$REPLY"
  note "different sessions, call B:            $diff"

  local same_recalled=0 diff_recalled=0
  printf '%s' "$same" | grep -qF "ALPHA-7741" && same_recalled=1
  printf '%s' "$diff" | grep -qF "ALPHA-7741" && diff_recalled=1

  if [ "$diff_recalled" -eq 1 ]; then
    fail "session_id is IGNORED — every caller shares one conversation"
    note ">>> BLOCKER for concurrent incidents: alert A's evidence lands in alert B's RCA."
    note ">>> Needs a platform answer (a header? a query param?) or one flow per stream."
  elif [ "$same_recalled" -eq 1 ]; then
    fail "the flow HAS memory, and sessions are real"
    note "Not a correctness blocker — the worker resends the whole transcript every round —"
    note "but the model then sees its history twice and re-issues tools it already ran."
    note ">>> Turn the memory / chat-history component OFF in the flow."
  else
    pass "no memory, or memory is not keyed by session — either way nothing leaks"
    note "This is what agent-builder.ts assumes. session_id stays cosmetic (the Slack threadId)."
  fi
  return 0
}

# ---------------------------------------------------------------------------------------
# P4a — what does a failure look like?
#
# extractText() throws on `error:true` inside a 200 body. That guard was written blind. If
# failures instead arrive as HTTP 200 with no marker at all, an error string reaches Slack
# wearing an RCA's clothes.
# ---------------------------------------------------------------------------------------
probe_failure() {
  bold "P4 — failure shape"
  local suspicious=0

  post "$dir/p1-smoke.txt" "gap-badkey-$$" "failure-badkey" "definitely-not-a-valid-key"
  note "bad x-api-key       -> HTTP $STATUS, message.error=$ERRFLAG"
  if [ "$STATUS" = "200" ]; then
    if [ "$ERRFLAG" = "true" ]; then
      pass "arrives as 200 but error:true — extractText's guard catches it"
    else
      suspicious=1
      fail "arrives as HTTP 200 with NO error marker"
      note "reply was: $(printf '%s' "$REPLY" | head -c 120)"
    fi
  else
    pass "non-2xx — the worker reports it as an error, no guard needed"
  fi

  local bad_flow="${AB_URL%/*}/00000000-0000-0000-0000-000000000000"
  post "$dir/p1-smoke.txt" "gap-badflow-$$" "failure-badflow" "$AB_KEY" "$bad_flow"
  note "nonexistent flow id -> HTTP $STATUS, message.error=$ERRFLAG"
  if [ "$STATUS" = "200" ] && [ "$ERRFLAG" != "true" ]; then
    suspicious=1
    fail "arrives as HTTP 200 with NO error marker"
  else
    pass "distinguishable from a real answer"
  fi

  if [ "$suspicious" -eq 1 ]; then
    note ">>> BLOCKER: a failure is indistinguishable from an answer, so it would be posted"
    note ">>> to Slack as an RCA. Find the marker the platform does set and add it to"
    note ">>> extractText() in llm-worker/src/agent-builder.ts before pointing this at alerts."
  fi
  return 0
}

# ---------------------------------------------------------------------------------------
# P4b — latency spread and concurrency
#
# One recorded full-size RCA took 104 s. Whether that was a cold start or the normal cost
# decides whether loop mode is usable, and an alert storm fires several at once.
# ---------------------------------------------------------------------------------------
probe_load() {
  bold "P4 — latency spread and concurrency (3 concurrent full-size RCAs)"
  note "One recorded run took 104s for a 3.4 KB payload. Three at once, different sessions."

  local pids=() i
  for i in 1 2 3; do
    (
      post "$dir/p2-full-rca.txt" "gap-load-$i-$$" "load-$i"
      printf '%s %s %s\n' "$STATUS" "$ELAPSED" "${#REPLY}" >"$out/load-$i.timing"
    ) &
    pids+=($!)
  done
  for i in "${pids[@]}"; do wait "$i" || true; done

  local worst=0 ok=1
  for i in 1 2 3; do
    read -r status secs len <"$out/load-$i.timing"
    note "run $i: HTTP $status in ${secs}s, ${len} chars back"
    [ "$status" = "200" ] || ok=0
    [ "$secs" -gt "$worst" ] && worst="$secs"
  done

  if [ "$ok" -eq 1 ]; then
    pass "all three concurrent runs answered"
  else
    fail "at least one concurrent run did not answer — check for a per-key rate limit"
  fi
  note "Slowest: ${worst}s. The agent allows up to 10 tool rounds, so budget"
  note "$(( worst * 10 ))s worst case to the first Slack message and decide if that is acceptable."
  note "If a gateway timeout sits in front of the flow it will show up here as a truncated wait."
  return 0
}

case "${1:-all}" in
  size) probe_size ;;
  session) probe_session ;;
  failure) probe_failure ;;
  load) probe_load ;;
  all) probe_size; probe_session; probe_failure; probe_load ;;
  *) echo "usage: run-gaps.sh [size|session|failure|load]" >&2; exit 1 ;;
esac

bold "Raw bodies saved under $out"
