#!/usr/bin/env bash
# Fire one A2A probe at the agent builder and print the raw response.
#
#   AB_URL=https://<agent-builder-host>/api/v1/run/<flow-id> \
#   AB_KEY=<x-api-key> \
#     ./run.sh p1-smoke.txt [session-id]
#
# Prints HTTP status, wall-clock seconds, and the unmodified response body.
# Nothing is parsed here on purpose: the point of the probe is to see the real
# envelope, including whatever the platform adds that the sample response omits.
set -euo pipefail

: "${AB_URL:?set AB_URL to the full /api/v1/run/<flow-id> URL}"
: "${AB_KEY:?set AB_KEY to the x-api-key value}"

payload_file="${1:?usage: run.sh <payload-file.txt> [session-id]}"
session="${2:-probe-$(date +%s)}"
dir="$(cd "$(dirname "$0")" && pwd)"
[ -f "$payload_file" ] || payload_file="$dir/$payload_file"

# jq builds the JSON so newlines, quotes and backslashes in the payload survive.
body="$(jq -Rs --arg s "$session" \
  '{input_type:"chat",output_type:"chat",input_value:.,session_id:$s}' \
  <"$payload_file")"

echo "--- POST $AB_URL  (session_id=$session, $(wc -c <"$payload_file") bytes in) ---" >&2
start=$(date +%s)
code=$(curl -sS -o /tmp/a2a-probe-body -w '%{http_code}' \
  --max-time 600 \
  --request POST --url "$AB_URL" \
  --header 'Content-Type: application/json' \
  --header "x-api-key: $AB_KEY" \
  --data "$body")
echo "--- HTTP $code in $(( $(date +%s) - start ))s ---" >&2
cat /tmp/a2a-probe-body
echo
