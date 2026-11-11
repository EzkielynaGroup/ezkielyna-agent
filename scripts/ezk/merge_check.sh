#!/bin/bash
# Check (and prepare) taking a new upstream OpenCode release.
#
# This repository was published with a fresh history, so it shares no commits with upstream OpenCode and a plain
# `git merge <tag>` would see unrelated histories. Instead the upstream change between the release we are based on
# (scripts/ezk/UPSTREAM_BASE) and the new tag is applied as a 3-way patch: git uses the upstream blobs of the base
# release as the common ancestor, so only files that both sides changed can conflict.
#
# Needs a remote named `upstream`:   git remote add upstream https://github.com/anomalyco/opencode.git
#   scripts/ezk/merge_check.sh v1.20.0            apply in a scratch worktree, bun install, run the unit + installer suite
#   scripts/ezk/merge_check.sh v1.20.0 --dry      conflict list only (no install, no tests)
#   scripts/ezk/merge_check.sh v1.20.0 --keep     keep the scratch worktree/branch to resolve conflicts there
# Your own branch is never touched. Exit codes: 0 clean (and tests pass), 1 conflicts, 2 tests failed, 3 setup problem.
set -uo pipefail
TAG="${1:?upstream tag, e.g. v1.20.0}"; shift || true
DRY=0; KEEP=0
for a in "$@"; do case $a in --dry) DRY=1 ;; --keep) KEEP=1 ;; esac; done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; APP="$ROOT"; BASE="${EZK_BASE_BRANCH:-main}"
UP_BASE="${EZK_UPSTREAM_BASE:-$(tr -d '[:space:]' < "$ROOT/scripts/ezk/UPSTREAM_BASE")}"
REMOTE="${EZK_UPSTREAM_REMOTE:-upstream}"
export PATH=$HOME/.bun/bin:$PATH
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ezk-merge-XXXXXX")"; WT="$TMP/app"; BR="merge-check/$TAG-$(date +%Y%m%d%H%M%S)"
cleanup() { [ "$KEEP" = 1 ] && { echo "kept worktree: $WT (branch $BR)"; return; }; git -C "$APP" worktree remove --force "$WT" >/dev/null 2>&1; git -C "$APP" branch -D "$BR" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

# Only the two release snapshots are needed, not upstream's history: shallow fetches keep this to a few hundred MB.
for t in "$UP_BASE" "$TAG"; do
  git -C "$APP" rev-parse -q --verify "refs/tags/$t^{commit}" >/dev/null && continue
  git -C "$APP" fetch --depth 1 --no-tags "$REMOTE" "refs/tags/$t:refs/tags/$t" >/dev/null 2>&1
  git -C "$APP" rev-parse -q --verify "refs/tags/$t^{commit}" >/dev/null || { echo "cannot fetch tag $t from remote '$REMOTE'"; exit 3; }
done
git -C "$APP" worktree add -q -b "$BR" "$WT" "$BASE" || exit 3
cd "$WT"
git diff --binary --find-renames "refs/tags/$UP_BASE" "refs/tags/$TAG" > "$TMP/upstream.patch" || exit 3
echo "upstream $UP_BASE..$TAG: $(grep -c '^diff --git' "$TMP/upstream.patch") files"
git apply --3way --index "$TMP/upstream.patch" > "$TMP/apply.out" 2>&1
CONFLICTS="$(git diff --name-only --diff-filter=U)"
if [ -n "$CONFLICTS" ] || grep -q '^error:' "$TMP/apply.out"; then
  echo "CONFLICTS ($(echo "$CONFLICTS" | grep -c . | tr -d ' ')) applying $UP_BASE..$TAG:"; echo "$CONFLICTS" | sed '/^$/d; s/^/  /'
  grep '^error:' "$TMP/apply.out" | sed 's/^/  /'
  echo "Resolve using docs/MODULES-EZK.md (our changes live in the ezkielyna-* / ezk files and the listed touch points)."
  exit 1
fi
echo "$UP_BASE..$TAG applies cleanly ($(git diff --cached --name-only | wc -l | tr -d ' ') files change)"
[ "$DRY" = 1 ] && exit 0
echo "$TAG" > scripts/ezk/UPSTREAM_BASE && git add scripts/ezk/UPSTREAM_BASE
git -c user.name=merge-check -c user.email=merge-check@localhost commit -q -m "upstream: OpenCode $UP_BASE..$TAG" || true
bun install --frozen-lockfile > "$TMP/install.log" 2>&1 || { KEEP=1; echo "bun install failed (see $TMP/install.log)"; exit 3; }
EZK_APP_DIR="$WT" "$ROOT/scripts/ezk/test_all.sh" --unit-only || { echo "tests FAILED after applying $TAG"; exit 2; }
echo "$TAG passes the unit suite"
