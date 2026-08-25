#!/usr/bin/env bash
# Run the loop-mode probes in order and save each raw response.
#
#   AB_URL=https://agent.builder.agus.run/api/run/<flow-id> \
#   AB_KEY=<x-api-key> \
#     ./run-loop.sh            # L1 L2 L3
#     ./run-loop.sh l4 l5      # named subset
#
# For each probe: prints payload bytes, HTTP status, wall-clock seconds, then the
# extracted answer text. The full raw body is saved to <probe>-response.json —
# the extraction below is a convenience for reading, not the contract. If it prints
# "(could not extract .outputs[0].outputs[0].results.message.text)", the envelope
# differs from the sample and THAT is a finding worth recording.
set -euo pipefail

: "${AB_URL:?set AB_URL to the full /api/run/<flow-id> URL}"
: "${AB_KEY:?set AB_KEY to the x-api-key value}"
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

dir="$(cd "$(dirname "$0")" && pwd)"
cd "$dir"

probes=("$@")
if [ ${#probes[@]} -eq 0 ]; then probes=(l1 l2 l3); fi

for p in "${probes[@]}"; do
  file=$(ls "${p}"*.txt 2>/dev/null | head -1)
  [ -n "$file" ] || { echo "no fixture matching ${p}*.txt" >&2; exit 1; }
  name="${file%.txt}"

  # Each probe is an independent round-1 call: our agent owns the transcript and
  # resends it whole, so the flow needs no memory of the previous probe. A fresh
  # session id per probe also keeps the platform's logs separable.
  session="loop-${name}-$(date +%s)"
  body=$(jq -Rs --arg s "$session" \
    '{input_type:"chat",output_type:"chat",input_value:.,session_id:$s}' <"$file")

  echo
  echo "=== $name — $(wc -c <"$file" | tr -d ' ') bytes in, session_id=$session ==="
  start=$(date +%s)
  code=$(curl -sS -o "${name}-response.json" -w '%{http_code}' \
    --max-time 600 \
    --request POST --url "$AB_URL" \
    --header 'Content-Type: application/json' \
    --header "x-api-key: $AB_KEY" \
    --data "$body" || echo "000")
  echo "--- HTTP $code in $(( $(date +%s) - start ))s -> ${name}-response.json"

  jq -re '.outputs[0].outputs[0].results.message.text' "${name}-response.json" 2>/dev/null \
    || { echo "(could not extract .outputs[0].outputs[0].results.message.text — raw body:)";
         cat "${name}-response.json"; echo; }
done

echo
echo "Done. Check each answer against the checklists in README.md."
