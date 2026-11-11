#!/usr/bin/env bash
set -euo pipefail

: "${EZK_BENCH_KEY:?Load EZK_BENCH_KEY from the VPS secret store before running this script}"
: "${EZK_BENCH_GATEWAY:?Set EZK_BENCH_GATEWAY to the HTTPS gateway base URL}"

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="ezk-bench2:local"
container="ezk-bench2-$(date -u +%Y%m%dT%H%M%S)-$$"
results_dir="${BENCH_RESULTS_DIR:-$repo_dir/bench/results/vps-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
mode="${BENCH_MODE:-run}"
# BENCH_AGENT=upstream (run mode) runs upstream OpenCode v1.19.3 (installed as /usr/local/bin/opencode in the image)
# against the same gateway with the same key; it has no router, so BENCH_MODEL must then name a concrete gateway model.
agent="${BENCH_AGENT:-ezkielyna}"
model="${BENCH_MODEL:-ezk-auto}"
case "$mode" in
  run)
    case "$agent" in
      ezkielyna|upstream) ;;
      *) echo "BENCH_AGENT must be ezkielyna or upstream" >&2; exit 2 ;;
    esac
    if [[ "$agent" == upstream && "$model" == ezk-auto ]]; then
      echo "BENCH_AGENT=upstream needs BENCH_MODEL=<gateway model>: upstream OpenCode has no ezk-auto router" >&2
      exit 2
    fi
    ;;
  ab)
    # Each arm is `EZK_FEATURES=...`, `agent=upstream`, or a mix such as 'agent=ezkielyna EZK_FEATURES=+mcp-defer'.
    : "${BENCH_A:?Set BENCH_A to arm A (feature flags or agent=...)}"
    : "${BENCH_B:?Set BENCH_B to arm B (feature flags or agent=...)}"
    BENCH_TASKS="${BENCH_TASKS:-category:bugfix}"
    BENCH_REPEATS="${BENCH_REPEATS:-2}"
    if [[ "$BENCH_A$BENCH_B" == *agent=upstream* && "$model" == ezk-auto && "$BENCH_A$BENCH_B" != *model=* ]]; then
      echo "an upstream arm needs BENCH_MODEL=<gateway model> (or model=<id> in the arm): upstream has no router" >&2
      exit 2
    fi
    ;;
  *) echo "BENCH_MODE must be run or ab" >&2; exit 2 ;;
esac
gateway_host="$(python3 -c 'import sys; from urllib.parse import urlparse; u=urlparse(sys.argv[1]); assert u.scheme == "https" and u.hostname and not u.username and not u.password and u.port in (None, 443) and not u.query and not u.fragment; print(u.hostname)' "$EZK_BENCH_GATEWAY")" || {
  echo "EZK_BENCH_GATEWAY must be an HTTPS URL on port 443 without credentials, query, or fragment" >&2
  exit 2
}
gateway_ip="$(getent ahostsv4 "$gateway_host" | awk 'NR == 1 { print $1 }')"
if [[ -z "$gateway_ip" ]]; then
  echo "could not resolve the configured gateway host to IPv4" >&2
  exit 2
fi

mkdir -p "$results_dir"
# /results is a bind mount owned by the in-container bench user (uid 10001): `docker cp` cannot read a tmpfs mount, so
# the 3 Nov 2026 run lost its JSONL/summary files that way; the files are handed back to the caller after the run
chown 10001:10001 "$results_dir"
chmod 0700 "$results_dir"
docker build -f "$repo_dir/bench/docker/Dockerfile" -t "$image" "$repo_dir"
docker_env=(--env EZK_BENCH_KEY --env EZK_BENCH_GATEWAY --env "EZK_BENCH_GATEWAY_IP=$gateway_ip")
if [[ "$mode" == ab ]]; then
  docker_env+=(--env "BENCH_A=$BENCH_A" --env "BENCH_B=$BENCH_B" --env "BENCH_TASKS=$BENCH_TASKS" --env "BENCH_REPEATS=$BENCH_REPEATS")
  bench_args=(--a "$BENCH_A" --b "$BENCH_B" --tasks "$BENCH_TASKS" --repeats "$BENCH_REPEATS" --gateway "$EZK_BENCH_GATEWAY" --key-env EZK_BENCH_KEY --model "$model" --max-budget 1 --out /results)
else
  bench_args=(--agent "$agent" --gateway "$EZK_BENCH_GATEWAY" --key-env EZK_BENCH_KEY --model "$model" --max-budget 1 --parallel 1 --out /results)
fi
# /tmp needs exec: Docker tmpfs defaults to noexec, so `go test` could not run its test binaries (Go tasks)
set +e
docker run --name "$container" \
  --cpus 2 \
  --memory 4g \
  --pids-limit 128 \
  --network bridge \
  --add-host "$gateway_host:$gateway_ip" \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=2g,uid=10001,gid=10001 \
  --mount "type=bind,src=$results_dir,dst=/results" \
  --cap-drop ALL \
  --cap-add NET_ADMIN \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --cap-add SETGID \
  --security-opt no-new-privileges:true \
  "${docker_env[@]}" \
  "$image" \
  "$mode" \
  "${bench_args[@]}"
run_status=$?
set -e

if docker container inspect "$container" >/dev/null 2>&1; then
  docker rm "$container" >/dev/null
fi
chown -R "$(id -u):$(id -g)" "$results_dir"
if [[ "$run_status" -ne 0 ]]; then
  exit "$run_status"
fi

printf 'Results saved to %s\n' "$results_dir"
