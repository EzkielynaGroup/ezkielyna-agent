#!/usr/bin/env bash
# Ezkielyna sandbox smoke test for macOS (Seatbelt). Run it on the Mac from the repo root:
#
#   bash scripts/sandbox-smoke-mac.sh            # SMOKE_URL=https://example.com by default
#
# It asks packages/core/src/ezk/sandbox for the exact sandbox-exec command the shell tool would use, runs each case
# through it and prints ok / FAIL per case, then runs scripts/sandbox-check.ts for the full matrix and the overhead.
# Exit 0 when every case matches. Needs bun and /usr/bin/sandbox-exec; works with the stock bash 3.2.
set -u

cd "$(dirname "$0")/.." || exit 2
REPO=$(pwd -P)
URL=${SMOKE_URL:-https://example.com}

if [ "$(uname)" != "Darwin" ]; then echo "macOS only (use: bun scripts/sandbox-check.ts on Linux)"; exit 2; fi
if [ ! -x /usr/bin/sandbox-exec ]; then echo "/usr/bin/sandbox-exec not found"; exit 2; fi
if ! command -v bun >/dev/null; then echo "bun not found"; exit 2; fi

ROOT=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ezk-sbx-mac-XXXXXX")" && pwd -P)
OUTSIDE=$(mktemp -d "$HOME/.ezk-sbx-mac-outside-XXXXXX")
trap 'rm -rf "$ROOT" "$OUTSIDE"' EXIT
mkdir "$ROOT/.git" "$ROOT/sub"
printf '[core]\n' >"$ROOT/.git/config"

# The sandbox-exec prefix for one escalation level, NUL-separated (the profile itself is one argument).
wrap() {
  EZK_SMOKE_REPO=$REPO EZK_SMOKE_ROOT=$ROOT EZK_SMOKE_ESCALATION=$1 bun -e '
    const { sandboxFor } = await import(process.env.EZK_SMOKE_REPO + "/packages/core/src/ezk/sandbox/index.ts")
    const plan = sandboxFor("smoke", "acceptEdits", process.env.EZK_SMOKE_ROOT, {
      env: { EZK_FEATURES: "+sandbox" },
      escalation: process.env.EZK_SMOKE_ESCALATION,
      shell: "/bin/bash",
    })
    // require_escalated runs outside the sandbox: no prefix at all.
    if (!plan.wrap && process.env.EZK_SMOKE_ESCALATION === "require_escalated") process.exit(0)
    if (!plan.wrap) {
      console.error("no sandbox: " + plan.reason + " " + (plan.unavailable ?? ""))
      process.exit(2)
    }
    process.stdout.write(plan.wrap.join("\0") + "\0")
  '
}

failed=0
check() { # name expected(allow|deny) escalation command
  local name=$1 expected=$2 escalation=$3 command=$4 arg got
  local argv=()
  while IFS= read -r -d '' arg; do argv+=("$arg"); done < <(wrap "$escalation")
  if [ "$escalation" != "require_escalated" ] && [ "${#argv[@]}" -eq 0 ]; then echo "FAIL  $name: could not build the sandbox command"; failed=1; return; fi
  # ${argv[@]+...}: an empty array is "unbound" under set -u in bash 3.2.
  if (cd "$ROOT" && ${argv[@]+"${argv[@]}"} /bin/bash -c "$command") >"$ROOT.out" 2>&1; then got=allow; else got=deny; fi
  if [ "$got" = "$expected" ]; then
    echo "ok    $name ($got)"
  else
    echo "FAIL  $name: expected $expected, got $got: $(tail -n 1 "$ROOT.out")"
    failed=1
  fi
  rm -f "$ROOT.out"
}

check "write inside the project root"            allow use_default  "echo ok > inside.txt && cat inside.txt"
check "write outside the root (home folder)"      deny  use_default  "echo x > '$OUTSIDE/x.txt'"
check "write .git/config"                         deny  use_default  "echo '[x]' >> .git/config"
check "create .git in a subfolder"                deny  use_default  "mkdir sub/.git"
check "read system files, run git"                allow use_default  "cat /etc/hosts >/dev/null && git --version >/dev/null"
check "curl (network off)"                        deny  use_default  "curl -sS --max-time 10 -o /dev/null '$URL'"
check "curl after with_network escalation"        allow with_network "curl -sS --max-time 10 -o /dev/null '$URL'"
check "write outside after require_escalated"     allow require_escalated "echo y > '$OUTSIDE/escalated.txt'"

if [ -e "$OUTSIDE/x.txt" ]; then echo "FAIL  the denied write left a file behind"; failed=1; fi
if [ "$(cat "$ROOT/.git/config")" != "[core]" ]; then echo "FAIL  .git/config was modified"; failed=1; fi

echo
echo "Full matrix and overhead (scripts/sandbox-check.ts):"
bun "$REPO/scripts/sandbox-check.ts" --runs 50 || failed=1

exit $failed
