#!/bin/bash
# Ad-hoc sign the packaged macOS app (no Apple Developer account) and rebuild zip + dmg from the signed bundle.
# usage: adhoc-sign-mac.sh <dist-dir> [arch=arm64] [version=1.19.3-ezk.1]   (dist-dir = packages/desktop/dist)
set -euo pipefail
DIST="$1"; ARCH="${2:-arm64}"; VER="${3:-$(cat "$(dirname "$0")/VERSION")}"
APP="$DIST/mac-$ARCH/Ezkielyna Agent.app"
[ -d "$APP" ] || APP="$DIST/mac/Ezkielyna Agent.app"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
rm -f "$DIST/ezkielyna-agent-$VER-mac-$ARCH.zip" "$DIST/ezkielyna-agent-$VER-mac-$ARCH.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/ezkielyna-agent-$VER-mac-$ARCH.zip"
STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Ezkielyna Agent" -srcfolder "$STAGE" -ov -format UDZO "$DIST/ezkielyna-agent-$VER-mac-$ARCH.dmg" >/dev/null
rm -rf "$STAGE"
echo "signed (ad-hoc) + repacked: $DIST/ezkielyna-agent-$VER-mac-$ARCH.{zip,dmg}"
