#!/usr/bin/env bash
# Phase 1 smoke test: creates two arenas, moves agents through every status, checks the snapshots.
# Usage: ARENA_URL=http://localhost:3000 ARENA_ADMIN_TOKEN=... scripts/smoke-api.sh
set -euo pipefail
: "${ARENA_URL:?set ARENA_URL}"
: "${ARENA_ADMIN_TOKEN:?set ARENA_ADMIN_TOKEN}"
command -v jq >/dev/null || { echo "needs jq" >&2; exit 2; }

suffix="smoke-$(date +%s)"
api() { # method path token [json]
  local args=(-sS -X "$1" "$ARENA_URL$2" -H "Authorization: Bearer $3" -w '\n%{http_code}')
  [[ $# -ge 4 ]] && args+=(-H 'Content-Type: application/json' --data-binary "$4")
  curl "${args[@]}"
}
expect() { # expected-status response
  local status="${2##*$'\n'}"
  [[ "$status" == "$1" ]] || { echo "expected HTTP $1, got $status: ${2%$'\n'*}" >&2; exit 1; }
  printf '%s' "${2%$'\n'*}"
}

create_arena() { # slug name theme -> the arena's first API key
  local body res
  body=$(jq -nc --arg slug "$1" --arg name "$2" --arg theme "$3" '{slug:$slug,name:$name,theme:$theme}')
  res=$(api POST /api/arenas "$ARENA_ADMIN_TOKEN" "$body")
  expect 201 "$res" | jq -r .apiKey.token
}
career_token=$(create_arena "career-$suffix" Career office)
personal_token=$(create_arena "personal-$suffix" Personal kitchen)
[[ "$career_token" == arena_* && "$personal_token" == arena_* ]] || { echo "arena creation failed" >&2; exit 1; }

for status_json in \
  '{"status":"idle"}' \
  '{"status":"working","activity":"Tailoring resume","progress":0.3}' \
  '{"status":"waiting","waitingOn":"human","waitingFor":"your approval"}' \
  '{"status":"error","error":"rate limited"}' \
  '{"status":"done","result":"## Resume\n- tailored for Acme"}'; do
  res=$(api POST "/api/arenas/career-$suffix/agents/resume-writer/status" "$career_token" "$status_json")
  [[ "${res##*$'\n'}" == 20[01] ]] || { echo "status report failed: $res" >&2; exit 1; }
  want=$(jq -r .status <<<"$status_json")
  got=$(jq -r '"\(.applied) \(.agent.status)"' <<<"${res%$'\n'*}")
  [[ "$got" == "true $want" ]] || { echo "expected 'true $want' after reporting $want, got '$got'" >&2; exit 1; }
done
expect 201 "$(api POST "/api/arenas/personal-$suffix/agents/meal-planner/status" "$personal_token" '{"status":"working","activity":"Planning dinners"}')" >/dev/null
expect 403 "$(api POST "/api/arenas/personal-$suffix/agents/x/status" "$career_token" '{"status":"idle"}')" >/dev/null

career=$(expect 200 "$(api GET "/api/arenas/career-$suffix" "$ARENA_ADMIN_TOKEN")")
personal=$(expect 200 "$(api GET "/api/arenas/personal-$suffix" "$personal_token")")
[[ $(jq -r '.agents[0].status' <<<"$career") == done ]] || { echo "career agent should be done" >&2; exit 1; }
[[ $(jq -r '.agents[0].resultPreview' <<<"$career") == *Acme* ]] || { echo "missing answer" >&2; exit 1; }
[[ $(jq -r '.agents[0].status' <<<"$personal") == working ]] || { echo "personal agent should be working" >&2; exit 1; }

expect 204 "$(api DELETE "/api/arenas/career-$suffix" "$ARENA_ADMIN_TOKEN")" >/dev/null
expect 204 "$(api DELETE "/api/arenas/personal-$suffix" "$ARENA_ADMIN_TOKEN")" >/dev/null
echo "smoke OK: two arenas, every status, snapshots correct"
