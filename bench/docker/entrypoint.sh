#!/usr/bin/env bash
set -euo pipefail

: "${EZK_BENCH_KEY:?EZK_BENCH_KEY must come from the VPS secret store}"
: "${EZK_BENCH_GATEWAY:?EZK_BENCH_GATEWAY must be an HTTPS gateway URL}"
: "${EZK_BENCH_GATEWAY_IP:?the run script must pin the gateway IP}"
: "${BENCH_UID:=10001}"
: "${BENCH_GID:=10001}"
mode=run
if [[ "${1:-}" == run || "${1:-}" == ab ]]; then
  mode="$1"
  shift
fi

if [[ "$EZK_BENCH_GATEWAY" != https://* ]]; then
  echo "EZK_BENCH_GATEWAY must use HTTPS" >&2
  exit 2
fi
if [[ ! "$EZK_BENCH_GATEWAY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "gateway IP must be an IPv4 address" >&2
  exit 2
fi

# Default-deny egress inside the container. DNS is pinned in /etc/hosts by run-vps.sh.
iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp -d "$EZK_BENCH_GATEWAY_IP" --dport 443 -j ACCEPT
iptables -F INPUT
iptables -P INPUT DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

export EZKIELYNA_BASE_URL="$EZK_BENCH_GATEWAY"
export EZK_NO_KEYCHAIN=1
export EZK_TRUST_PROJECT=1
export NO_COLOR=1
export HOME=/tmp/bench-home
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
# created as the bench user: root here has no CAP_CHOWN, and root-owned dirs made `go test` in the verify step fail with
# "mkdir /tmp/bench-home/.cache/go-build: permission denied" (all three Go tasks, 3 Nov 2026 real run)
setpriv --reuid="$BENCH_UID" --regid="$BENCH_GID" --clear-groups \
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

exec setpriv --bounding-set=-all --reuid="$BENCH_UID" --regid="$BENCH_GID" --clear-groups --no-new-privs \
  bun "/workspace/bench/$mode.ts" "$@"
