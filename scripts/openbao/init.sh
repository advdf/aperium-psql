#!/bin/sh
# Wrapper around `bao server` that adds first-boot init + auto-unseal so the
# persistent OpenBao sidecar comes back online unattended after every restart.
#
# Layout under the openbao-data volume:
#   /openbao/data/        ← OpenBao file storage (sealed raft equivalent)
#   /openbao/state/init.json     ← unseal key + root token (written on first init)
#   /openbao/state/.kv-enabled   ← marker that secret/ KV v2 mount is enabled
#   /openbao/state/root-token    ← the root token alone, for the bootstrap + app
#
# This is a DEV pattern. In production the unseal key MUST live outside the
# data volume (Shamir keys split across operators, auto-unseal via transit /
# AWS KMS / GCP KMS, etc.).

set -e

CONFIG=/openbao/config/config.hcl
STATE_DIR=/openbao/state
INIT_FILE="$STATE_DIR/init.json"
ROOT_TOKEN_FILE="$STATE_DIR/root-token"
KV_FLAG="$STATE_DIR/.kv-enabled"
ADDR="http://127.0.0.1:8200"

export BAO_ADDR="$ADDR"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

echo "[openbao-init] starting server with config $CONFIG"
bao server -config="$CONFIG" &
SERVER_PID=$!

# Wait for the listener to come up. `bao status` exits 0 (unsealed) / 1
# (network error) / 2 (sealed or uninitialized). We need "reachable at all",
# so we keep retrying until the JSON output contains the expected fields.
i=0
while :; do
  out=$(bao status -format=json 2>/dev/null || true)
  if echo "$out" | grep -q '"initialized"'; then
    break
  fi
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[openbao-init] server did not become reachable in 30s"
    kill "$SERVER_PID" 2>/dev/null
    exit 1
  fi
  sleep 0.5
done

INITIALIZED=$(echo "$out" | grep -o '"initialized":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')
echo "[openbao-init] initialized=$INITIALIZED"

# JSON helpers — `bao operator init -format=json` pretty-prints across
# multiple lines, so we flatten before grepping. No jq in the openbao image.
extract_root_token() {
  tr -d '\n' < "$1" | sed -n 's/.*"root_token":[ ]*"\([^"]*\)".*/\1/p'
}
extract_unseal_key() {
  tr -d '\n' < "$1" | sed -n 's/.*"unseal_keys_b64":[ ]*\[[ ]*"\([^"]*\)".*/\1/p'
}

if [ "$INITIALIZED" != "true" ]; then
  echo "[openbao-init] first boot — initializing with single shamir share"
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"
  chmod 600 "$INIT_FILE"
  # Cache root token in a separate file so the aperium container can read it
  # without having to parse json. The bootstrap container does the same.
  extract_root_token "$INIT_FILE" > "$ROOT_TOKEN_FILE"
  chmod 600 "$ROOT_TOKEN_FILE"
  echo "[openbao-init] init.json + root-token written to $STATE_DIR"
fi

UNSEAL_KEY=$(extract_unseal_key "$INIT_FILE")
if [ -z "$UNSEAL_KEY" ]; then
  echo "[openbao-init] could not extract unseal key from $INIT_FILE"
  kill "$SERVER_PID" 2>/dev/null
  exit 1
fi

SEALED=$(bao status -format=json 2>/dev/null | grep -o '"sealed":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')
if [ "$SEALED" = "true" ]; then
  echo "[openbao-init] unsealing"
  bao operator unseal "$UNSEAL_KEY" > /dev/null
fi

# Enable the KV v2 mount once. The marker file lives outside the data volume
# in spirit, but co-locating it here is fine for the dev setup — if the data
# volume is wiped, the marker is wiped too, and the next boot re-enables.
if [ ! -f "$KV_FLAG" ]; then
  export BAO_TOKEN
  BAO_TOKEN=$(cat "$ROOT_TOKEN_FILE")
  if bao secrets enable -path=secret -version=2 kv > /dev/null 2>&1; then
    echo "[openbao-init] enabled KV v2 at secret/"
  else
    # Already enabled (e.g. on a previous boot before the marker file landed) —
    # treat as success.
    echo "[openbao-init] KV v2 at secret/ already enabled"
  fi
  touch "$KV_FLAG"
fi

echo "[openbao-init] ready — server pid $SERVER_PID"

# Forward signals to the server.
trap 'kill -TERM $SERVER_PID 2>/dev/null; wait $SERVER_PID' TERM INT
wait "$SERVER_PID"
