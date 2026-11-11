#!/usr/bin/env bash
# Installs the Ezkielyna Agent CLI on a Linux runner. The installer and the release are both signature-checked:
# 1. install.sh is downloaded with its detached signature and checked against the pinned release key (ECDSA P-256,
#    key id 6f357cf04af3cb4d, the same key the installer itself uses). A bad signature stops the job.
# 2. The installer then verifies the signed manifest, the signed checksum list and the archive checksum itself.
# EZK_ACTION_DRY_RUN=1 skips all of this (tests use a fake binary).
set -euo pipefail

if [ "${EZK_ACTION_DRY_RUN:-}" = "1" ]; then
  echo "dry run: skipping install"
  exit 0
fi

BASE="${EZK_INSTALL_BASE:-https://ezkielyna.store/agent}"
VERSION_IN="${EZK_VERSION:-latest}"
die() { echo "::error title=Ezkielyna Agent install::$*"; exit 1; }

[ "$(uname -s)" = Linux ] || die "Linux runners only"
for c in curl openssl; do command -v "$c" >/dev/null || die "$c is required"; done

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/pub.pem" <<'PEM'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6pZu7S24ONm8sScK1XgKDsklqr0F
t1So/uGHhPABBqbyLQjo5Tr7nJ0wI26IS+pbZowhgmkSJw/tHxifomD9yw==
-----END PUBLIC KEY-----
PEM

curl -fsSL --retry 3 "$BASE/install.sh" -o "$tmp/install.sh" || die "could not download install.sh"
curl -fsSL --retry 3 "$BASE/install.sh.sig" -o "$tmp/install.sh.sig" || die "could not download install.sh.sig"
openssl dgst -sha256 -verify "$tmp/pub.pem" -signature "$tmp/install.sh.sig" "$tmp/install.sh" >/dev/null 2>&1 \
  || die "signature of install.sh does not verify; refusing to run it"

if [ "$VERSION_IN" = latest ]; then
  sh "$tmp/install.sh" --no-modify-path
else
  sh "$tmp/install.sh" --no-modify-path --version "$VERSION_IN"
fi

bin="${EZK_INSTALL_DIR:-$HOME/.ezkielyna}/bin"
echo "$bin" >> "${GITHUB_PATH:-/dev/null}"
"$bin/ezkielyna" --version
