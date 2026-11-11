#!/bin/bash
# ONE command that runs every Ezkielyna Agent test. Tested on macOS arm64; written to also run on Linux (not yet verified there).
#   scripts/ezk/test_all.sh                 everything that applies to this machine
#   scripts/ezk/test_all.sh --unit-only     unit + installer tests only (used by merge_check.sh)
#   scripts/ezk/test_all.sh --typecheck     also run the TypeScript checks
# Needs `bun install` in the repository root first.
# Optional: EZK_CLI_BIN=<compiled ezkielyna binary> (CLI e2e), EZK_DESKTOP_EXE=<packaged app executable> (desktop smoke).
# Without those variables the script uses the locally built binaries when present and reports "skipped" otherwise.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; APP="${EZK_APP_DIR:-$ROOT}"
export PATH=$HOME/.bun/bin:$PATH
UNIT_ONLY=0; TYPES=0
for a in "$@"; do case $a in --unit-only) UNIT_ONLY=1 ;; --typecheck) TYPES=1 ;; esac; done
declare -a RESULTS; FAILED=0
step() { # name, command...
  local name="$1"; shift
  local t0=$SECONDS log="/tmp/ezk-test-$$-${#RESULTS[@]}.log"
  if "$@" >"$log" 2>&1; then RESULTS+=("PASS  $name ($((SECONDS - t0))s)")
  else RESULTS+=("FAIL  $name ($((SECONDS - t0))s)  log: $log"); FAILED=1; tail -25 "$log" | sed 's/^/      /'; fi
}
skip() { RESULTS+=("SKIP  $1 ($2)"); }
inside() { ( cd "$1" && shift && "$@" ); }

step "unit: core (model discovery, errors, secrets, redaction, update verifier, device login, quota adapter, trust, theme/i18n)" inside "$APP/packages/core" bun test test/ezkielyna
step "unit: desktop (guards, verified updater)"                      inside "$APP/packages/desktop" bun test src/main/ezkielyna-guards.test.ts src/main/ezkielyna-updater.test.ts
step "unit: app (i18n parity)"                                       inside "$APP/packages/app" bun test src/i18n
step "unit: tui (update dialog)"                                    inside "$APP/packages/tui" bun test test/component
step "unit: opencode (auth, keychain migration, agent permissions, installation, upgrade check, config)" inside "$APP/packages/opencode" bun test test/auth test/agent test/installation test/cli/upgrade.test.ts test/config
step "installer: signature, checksum, tamper refusal"                sh "$ROOT/scripts/ezk/e2e/installer_test.sh"

if [ $TYPES = 1 ]; then
  step "typecheck: core"     inside "$APP/packages/core" bun run typecheck
  step "typecheck: opencode" inside "$APP/packages/opencode" bun run typecheck
  step "typecheck: app"      inside "$APP/packages/app" bun run typecheck
  step "typecheck: desktop"  inside "$APP/packages/desktop" bun run typecheck
fi

if [ $UNIT_ONLY = 0 ]; then
  CLI="${EZK_CLI_BIN:-}"
  if [ -z "$CLI" ]; then
    for c in "$APP/packages/opencode/dist/opencode-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')/bin/ezkielyna"; do [ -x "$c" ] && CLI="$c"; done
  fi
  if [ -n "$CLI" ]; then step "e2e: CLI against a mock OpenAI server (18 checks)" bun "$ROOT/scripts/ezk/e2e/cli_smoke.ts" "$CLI"; else skip "e2e: CLI" "no compiled binary; set EZK_CLI_BIN"; fi

  EXE="${EZK_DESKTOP_EXE:-}"
  [ -z "$EXE" ] && [ "$(uname -s)" = Darwin ] && [ -x "$APP/packages/desktop/dist/mac-arm64/Ezkielyna Agent.app/Contents/MacOS/Ezkielyna Agent" ] && EXE="$APP/packages/desktop/dist/mac-arm64/Ezkielyna Agent.app/Contents/MacOS/Ezkielyna Agent"
  if [ -n "$EXE" ]; then
    if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then step "e2e: desktop smoke (xvfb, hidden)" xvfb-run -a env EZK_TEST_HIDDEN=1 bun "$ROOT/scripts/ezk/e2e/desktop_smoke.ts" "$EXE"
    else step "e2e: desktop smoke (hidden window, own profile, auto quit)" env EZK_TEST_HIDDEN=1 bun "$ROOT/scripts/ezk/e2e/desktop_smoke.ts" "$EXE"; fi
  else skip "e2e: desktop smoke" "no packaged app; set EZK_DESKTOP_EXE"; fi
fi

printf '\n== Ezkielyna Agent test summary ==\n'; printf '%s\n' "${RESULTS[@]}"
[ $FAILED = 0 ] && echo "ALL PASSED" || echo "FAILURES"
exit $FAILED
