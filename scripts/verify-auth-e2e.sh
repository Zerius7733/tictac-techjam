#!/usr/bin/env bash

# End-to-end verification for the human-auth and Agent-policy boundary.
# Usage: BASE_URL=http://127.0.0.1:3310 DB_PATH=/tmp/.../auth.db bash scripts/verify-auth-e2e.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
DB_PATH="${DB_PATH:-data/auth.db}"
response="$(mktemp /tmp/launchpad-auth-response.XXXXXX)"
trap 'rm -f "$response"' EXIT

request() {
  local expected="$1"
  shift
  local actual
  actual="$(curl -s -o "$response" -w "%{http_code}" "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL expected HTTP $expected, got $actual"
    cat "$response"
    exit 1
  fi
}

assert_json() {
  jq -e "$1" "$response" >/dev/null || {
    echo "FAIL JSON assertion: $1"
    cat "$response"
    exit 1
  }
}

request 200 "$BASE_URL/api/health"
assert_json '.ok == true'
echo "PASS health"

request 200 "$BASE_URL/api/auth"
assert_json '.loginRequired == true and .authenticated == false'
echo "PASS auth status"

request 401 "$BASE_URL/api/agents"
echo "PASS unauthenticated requests are rejected"

request 401 -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"wrong"}' \
  -X POST "$BASE_URL/api/auth/login"
echo "PASS invalid password is rejected"

request 200 -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-demo-2026"}' \
  -X POST "$BASE_URL/api/auth/login"
ALICE_SESSION="$(jq -r '.sessionToken' "$response")"
echo "PASS Alice login"

request 200 -H "Authorization: Bearer $ALICE_SESSION" "$BASE_URL/api/auth/me"
assert_json '.user.username == "alice" and (.user.roleNames | index("developer")) != null'
echo "PASS Alice identity and role"

request 201 -H "Authorization: Bearer $ALICE_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice live security agent","description":"E2E policy test"}' \
  -X POST "$BASE_URL/api/agents"
AGENT_ID="$(jq -r '.agent.id' "$response")"
OWNER_ID="$(jq -r '.agent.ownerUserId' "$response")"
PRINCIPAL_ID="$(jq -r '.agent.principalId' "$response")"
test "$OWNER_ID" != null && test "$PRINCIPAL_ID" != null
echo "PASS Agent creation assigns owner and principal"

request 200 -H "Authorization: Bearer $ALICE_SESSION" "$BASE_URL/api/agents"
jq -e --arg agent "$AGENT_ID" '(.agents | map(.id) | index($agent)) != null' "$response" >/dev/null || {
  echo "FAIL Alice cannot see the Agent she created"
  cat "$response"
  exit 1
}
echo "PASS Alice can see her Agent"

request 200 -H 'Content-Type: application/json' \
  -d '{"username":"bob","password":"bob-demo-2026"}' \
  -X POST "$BASE_URL/api/auth/login"
BOB_SESSION="$(jq -r '.sessionToken' "$response")"
echo "PASS Bob login"

request 200 -H "Authorization: Bearer $BOB_SESSION" "$BASE_URL/api/agents"
assert_json '.agents | length == 0'
echo "PASS Bob cannot list Alice Agent"

request 404 -H "Authorization: Bearer $BOB_SESSION" "$BASE_URL/api/agents/$AGENT_ID"
echo "PASS Bob cannot fetch Alice Agent"

request 403 -H "Authorization: Bearer $BOB_SESSION" \
  -H 'Content-Type: application/json' -d '{"expiresInSeconds":3600}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/credentials"
echo "PASS Bob cannot issue an Agent credential"

request 201 -H "Authorization: Bearer $ALICE_SESSION" \
  -H 'Content-Type: application/json' -d '{"expiresInSeconds":3600}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/credentials"
AGENT_TOKEN="$(jq -r '.credential.token' "$response")"
CREDENTIAL_ID="$(jq -r '.credential.id' "$response")"
[[ "$AGENT_TOKEN" == agt_* ]]
echo "PASS independent Agent credential issuance"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  "$BASE_URL/api/agents/$AGENT_ID/credentials"
assert_json '(.credentials[0] | has("token")) == false'
echo "PASS raw Agent token is not listed"

request 401 -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
echo "PASS Agent endpoint requires an Agent credential"

request 403 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.reasonCode == "capability_not_granted"'
echo "PASS credential alone does not grant access"

request 200 -H "Authorization: Bearer $ALICE_SESSION" "$BASE_URL/api/security/mock-resources"
assert_json 'any(.resources[]; .resourceKey == "alice-private-note") and any(.resources[]; .resourceKey == "shared-status") and (any(.resources[]; .resourceKey == "bob-private-note") | not)'
echo "PASS resource listing is owner-filtered"

request 201 -H "Authorization: Bearer $ALICE_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"resourceType":"mock_record","resourceKey":"alice-private-note","action":"read","expiresInSeconds":3600}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/capabilities"
READ_CAPABILITY_ID="$(jq -r '.capability.id' "$response")"
echo "PASS exact read capability grant"

request 200 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.status == "allowed" and (.resource.value | contains("Alice private note"))'
echo "PASS Agent read after capability grant"

request 403 -H "Authorization: Bearer $ALICE_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"resourceType":"mock_record","resourceKey":"bob-private-note","action":"read","expiresInSeconds":3600}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/capabilities"
echo "PASS cross-user private grant rejected"

request 403 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"bob-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.reasonCode == "resource_owner_mismatch"'
echo "PASS cross-user private read rejected"

request 201 -H "Authorization: Bearer $ALICE_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"resourceType":"mock_record","resourceKey":"alice-private-note","action":"write","expiresInSeconds":3600}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/capabilities"
WRITE_CAPABILITY_ID="$(jq -r '.capability.id' "$response")"
echo "PASS exact write capability grant"

request 403 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"write","resourceType":"mock_record","resourceKey":"alice-private-note","inputText":"Live approved replacement"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.status == "approval_required"'
APPROVAL_ID="$(jq -r '.approval.id' "$response")"
echo "PASS write requires approval"

request 404 -H "Authorization: Bearer $BOB_SESSION" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/approvals/$APPROVAL_ID/approve"
echo "PASS Bob cannot approve Alice Agent action"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/approvals/$APPROVAL_ID/approve"
assert_json '.approval.status == "approved"'
echo "PASS Alice approval"

request 200 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"write","resourceType":"mock_record","resourceKey":"alice-private-note","inputText":"Live approved replacement"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.status == "allowed" and .reasonCode == "write_completed"'
echo "PASS approved write"

request 403 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"write","resourceType":"mock_record","resourceKey":"alice-private-note","inputText":"Live approved replacement"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.status == "approval_required"'
echo "PASS consumed approval cannot be replayed"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/stop"
assert_json '.agent.status == "stopped"'
request 403 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.reasonCode == "agent_inactive"'
echo "PASS stopped Agent cannot execute"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/start"
request 200 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.status == "allowed"'
echo "PASS restarted Agent can execute"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  "$BASE_URL/api/agents/$AGENT_ID/action-logs"
assert_json '(.actions | length) >= 8 and any(.actions[]; .resultCode == "approval_required") and any(.actions[]; .resultCode == "write_completed")'
echo "PASS Agent action attribution"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/capabilities/$READ_CAPABILITY_ID/revoke"
request 403 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
assert_json '.reasonCode == "capability_not_granted"'
echo "PASS capability revocation"

request 201 -H "Authorization: Bearer $ALICE_SESSION" \
  -H 'Content-Type: application/json' -d '{"expiresInSeconds":3600}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/credentials"
EXPIRED_CREDENTIAL_ID="$(jq -r '.credential.id' "$response")"
EXPIRED_AGENT_TOKEN="$(jq -r '.credential.token' "$response")"
sqlite3 "$DB_PATH" "UPDATE agent_principal_credentials SET expires_at='1970-01-01T00:00:00.000Z' WHERE id='$EXPIRED_CREDENTIAL_ID';"
request 401 -H "X-Agent-Principal-Token: $EXPIRED_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
echo "PASS expired Agent credential"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/credentials/$CREDENTIAL_ID/revoke"
request 401 -H "X-Agent-Principal-Token: $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}' \
  -X POST "$BASE_URL/api/agent/tool-calls"
echo "PASS revoked Agent credential"

request 200 -H "Authorization: Bearer $ALICE_SESSION" \
  -X POST "$BASE_URL/api/auth/logout"
request 401 -H "Authorization: Bearer $ALICE_SESSION" "$BASE_URL/api/agents"
echo "PASS human session logout"

test "$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')" = ok
test "$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM schema_migrations;')" -ge 4
test "$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agent_principal_credentials WHERE token_hash='$AGENT_TOKEN';")" = 0
test "$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM agent_action_logs;')" -ge 8
echo "PASS SQLite integrity, migration state, token hashing, and action persistence"
echo "LIVE AUTH E2E COMPLETE"
