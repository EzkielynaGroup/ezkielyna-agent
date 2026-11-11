#!/bin/sh
# Offline test of the `install` script in the repository root: a good signed release installs; tampered archive, tampered manifest, wrong key and
# an unlisted archive are all refused and install nothing. Uses a throwaway key (the real public key block in a COPY of
# the script is swapped for the test key; the shipped script is never modified).
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0; ok() { printf 'ok   %s\n' "$1"; }; bad() { printf 'FAIL %s\n' "$1"; fail=1; }
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; *) arch=x64 ;; esac
VER=9.9.9-test.1

openssl ecparam -name prime256v1 -genkey -noout -out "$T/k.pem" 2>/dev/null
openssl ec -in "$T/k.pem" -pubout -out "$T/pub.pem" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$T/other.pem" 2>/dev/null

# patched copy of the installer carrying the test public key
awk -v pub="$T/pub.pem" '
  /^-----BEGIN PUBLIC KEY-----$/ { while ((getline line < pub) > 0) print line; skip=1; next }
  skip && /^-----END PUBLIC KEY-----$/ { skip=0; next }
  !skip { print }' "$ROOT/install" > "$T/install.sh"

mkrel() { # dir
  d="$1"; rm -rf "$d"; mkdir -p "$d" "$T/stage/ezkielyna-$VER-$os-$arch"
  printf '#!/bin/sh\necho "fake ezkielyna"\n' > "$T/stage/ezkielyna-$VER-$os-$arch/ezkielyna"
  tar -czf "$d/ezkielyna-$VER-$os-$arch.tar.gz" -C "$T/stage" "ezkielyna-$VER-$os-$arch"
  printf '{"version": "%s"}\n' "$VER" > "$d/latest.json"
  ( cd "$d" && if command -v sha256sum >/dev/null; then sha256sum ezkielyna-*.tar.gz; else shasum -a 256 ezkielyna-*.tar.gz; fi ) > "$d/SHA256SUMS"
  for f in latest.json SHA256SUMS; do openssl dgst -sha256 -sign "${2:-$T/k.pem}" -out "$d/$f.sig" "$d/$f"; done
}
run() { # release dir, install dir
  HOME="$T/home" EZK_INSTALL_DIR="$2" sh "$T/install.sh" --local "$1" --no-modify-path >"$T/out.txt" 2>&1
}
mkdir -p "$T/home"

mkrel "$T/good"
run "$T/good" "$T/i1" && [ -x "$T/i1/bin/ezkielyna" ] && "$T/i1/bin/ezk" | grep -q "fake ezkielyna" && ok "signed release installs and runs" || { bad "signed release installs and runs"; cat "$T/out.txt"; }

mkrel "$T/t1"; printf 'x' >> "$T/t1/ezkielyna-$VER-$os-$arch.tar.gz"
run "$T/t1" "$T/i2" && bad "tampered archive was accepted" || { grep -q "checksum mismatch" "$T/out.txt" && [ ! -e "$T/i2/bin/ezkielyna" ] && ok "tampered archive refused"; } || bad "tampered archive refused"

mkrel "$T/t2"; sed 's/9.9.9/9.9.8/' "$T/t2/latest.json" > "$T/t2/l" && mv "$T/t2/l" "$T/t2/latest.json"
run "$T/t2" "$T/i3" && bad "tampered manifest was accepted" || { grep -q "signature of latest.json does not verify" "$T/out.txt" && [ ! -e "$T/i3/bin/ezkielyna" ] && ok "tampered manifest refused"; } || bad "tampered manifest refused"

mkrel "$T/t3" "$T/other.pem"
run "$T/t3" "$T/i4" && bad "wrong-key signature was accepted" || { grep -q "does not verify" "$T/out.txt" && [ ! -e "$T/i4/bin/ezkielyna" ] && ok "signature from another key refused"; } || bad "signature from another key refused"

mkrel "$T/t4"; sed '$d' "$T/t4/SHA256SUMS" > /dev/null; : > "$T/t4/SHA256SUMS"; openssl dgst -sha256 -sign "$T/k.pem" -out "$T/t4/SHA256SUMS.sig" "$T/t4/SHA256SUMS"
run "$T/t4" "$T/i5" && bad "archive missing from signed list was accepted" || { grep -q "not listed in the signed SHA256SUMS" "$T/out.txt" && ok "archive not in the signed list refused"; } || bad "unlisted archive refused"

mkrel "$T/t5"; rm "$T/t5/latest.json.sig"
run "$T/t5" "$T/i6" && bad "missing signature was accepted" || ok "missing signature refused"

# no downgrade: a newer installed version is not replaced by an older signed release (EZK_ALLOW_DOWNGRADE=1 overrides)
mkrel "$T/dg"; mkdir -p "$T/i7/current"; printf '#!/bin/sh\necho 99.0.0\n' > "$T/i7/current/ezkielyna"; chmod +x "$T/i7/current/ezkielyna"
run "$T/dg" "$T/i7" && bad "downgrade was accepted" || { grep -q "refusing to downgrade" "$T/out.txt" && ok "downgrade to an older signed release refused"; } || bad "downgrade refused"
HOME="$T/home" EZK_INSTALL_DIR="$T/i7" EZK_ALLOW_DOWNGRADE=1 sh "$T/install.sh" --local "$T/dg" --no-modify-path >"$T/out.txt" 2>&1 && ok "EZK_ALLOW_DOWNGRADE=1 overrides" || { bad "override"; cat "$T/out.txt"; }

# --- first-run fixes (22 Oct dry run) ---
# --help works when the script is piped into sh (there is no $0 file to read)
out="$(cat "$T/install.sh" | sh -s -- --help 2>&1)" && printf '%s' "$out" | grep -q -- "--no-modify-path" && printf '%s' "$out" | grep -q "EZK_INSTALL_DIR" && ok "--help works when piped into sh" || bad "--help works when piped into sh"
out="$(sh "$T/install.sh" --help 2>&1)" && printf '%s' "$out" | grep -q "Usage\|Options:" && ok "--help works from a file" || bad "--help works from a file"

# tool shims: a PATH with the usual tools but no openssl; a Linux/musl system
mkdir -p "$T/nossl" "$T/musl"
for tool in tar uname awk sed mktemp rm mkdir cat grep sort head tail cp ln chmod ls basename dirname sha256sum shasum xattr ldd curl cut tr date; do
  p="$(command -v "$tool" 2>/dev/null || true)"; [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" "$T/nossl/$tool"
done
mkrel "$T/good2"
PATH="$T/nossl" HOME="$T/home" EZK_INSTALL_DIR="$T/i8" /bin/sh "$T/install.sh" --local "$T/good2" --no-modify-path >"$T/out.txt" 2>&1 && bad "installed without openssl" || { grep -q "sudo apt install openssl" "$T/out.txt" && [ ! -e "$T/i8/bin/ezkielyna" ] && ok "missing openssl: hint to apt install it"; } || bad "missing openssl hint"

printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n' > "$T/musl/uname"; chmod +x "$T/musl/uname"
PATH="$T/musl:$PATH" EZK_LIBC=musl HOME="$T/home" EZK_INSTALL_DIR="$T/i9" sh "$T/install.sh" --local "$T/good2" --no-modify-path >"$T/out.txt" 2>&1 && bad "installed on musl" || { grep -q "musl" "$T/out.txt" && grep -q "Alpine" "$T/out.txt" && [ ! -e "$T/i9/bin/ezkielyna" ] && ok "musl/Alpine refused with a clear sentence"; } || bad "musl refused"

# network: a dead server prints curl's exit code and says to run the same command again (retries make this take a few seconds)
HOME="$T/home" EZK_INSTALL_DIR="$T/i10" EZK_BASE_URL="http://127.0.0.1:9" sh "$T/install.sh" --no-modify-path >"$T/out.txt" 2>&1 && bad "installed from a dead server" || { grep -q "curl exit code 7" "$T/out.txt" && grep -q "run the same command again" "$T/out.txt" && ok "download failure shows curl's exit code and 'run the same command again'"; } || { bad "download failure message"; cat "$T/out.txt"; }
# ...and a working base URL (file://) goes through the same curl path with retry and resume flags
HOME="$T/home" EZK_INSTALL_DIR="$T/i11" EZK_BASE_URL="file://$T/good2" sh "$T/install.sh" --no-modify-path >"$T/out.txt" 2>&1 && [ -x "$T/i11/bin/ezkielyna" ] && ok "download through curl (file:// base) installs" || { bad "download through curl"; cat "$T/out.txt"; }

# PATH: existing rc file is extended; no 'If the command is not found' line; nothing to type by hand
rm -rf "$T/h1"; mkdir -p "$T/h1"; : > "$T/h1/.zshrc"
HOME="$T/h1" SHELL=/bin/zsh EZK_INSTALL_DIR="$T/i12" sh "$T/install.sh" --local "$T/good2" >"$T/out.txt" 2>&1
grep -q "$T/i12/bin" "$T/h1/.zshrc" && grep -q "Added" "$T/out.txt" && ! grep -q "If the command is not found" "$T/out.txt" && ! grep -q "echo '" "$T/out.txt" && ok "PATH added to an existing .zshrc, no redundant hint" || { bad "PATH added to existing .zshrc"; cat "$T/out.txt"; }
# second run does not duplicate the line (the fake binary prints no version, so the no-downgrade check may stop it: allow that)
HOME="$T/h1" SHELL=/bin/zsh EZK_ALLOW_DOWNGRADE=1 EZK_INSTALL_DIR="$T/i12" sh "$T/install.sh" --local "$T/good2" >"$T/out.txt" 2>&1 || true
[ "$(grep -c "$T/i12/bin" "$T/h1/.zshrc")" = 1 ] && ok "PATH line is not added twice" || bad "PATH line duplicated"
# no rc file: macOS+zsh creates ~/.zshrc; elsewhere the exact echo command is printed
rm -rf "$T/h2"; mkdir -p "$T/h2"
HOME="$T/h2" SHELL=/bin/zsh EZK_INSTALL_DIR="$T/i13" sh "$T/install.sh" --local "$T/good2" >"$T/out.txt" 2>&1
if [ "$os" = darwin ]; then
  grep -q "$T/i13/bin" "$T/h2/.zshrc" 2>/dev/null && ok "macOS + zsh without ~/.zshrc: created with the PATH line" || { bad "macOS zsh .zshrc created"; cat "$T/out.txt"; }
else
  [ ! -e "$T/h2/.zshrc" ] && grep -q "echo 'export PATH=\"$T/i13/bin:\$PATH\"' >> $T/h2/.zshrc" "$T/out.txt" && ok "no rc file: the exact echo command is printed" || { bad "echo command printed"; cat "$T/out.txt"; }
fi
rm -rf "$T/h3"; mkdir -p "$T/h3"
HOME="$T/h3" SHELL=/bin/bash EZK_INSTALL_DIR="$T/i14" sh "$T/install.sh" --local "$T/good2" >"$T/out.txt" 2>&1
if [ "$os" = darwin ]; then rcfile="$T/h3/.bash_profile"; else rcfile="$T/h3/.bashrc"; fi
grep -q "echo 'export PATH=\"$T/i14/bin:\$PATH\"' >> $rcfile" "$T/out.txt" && [ ! -e "$rcfile" ] && ! grep -q "If the command is not found" "$T/out.txt" && ok "bash without an rc file: the exact echo command is printed" || { bad "bash echo command"; cat "$T/out.txt"; }
HOME="$T/h3" SHELL=/bin/bash EZK_INSTALL_DIR="$T/i15" sh "$T/install.sh" --local "$T/good2" --no-modify-path >"$T/out.txt" 2>&1
[ ! -e "$T/h3/.zshrc" ] && [ ! -e "$T/h3/.bashrc" ] && ok "--no-modify-path touches no profile" || bad "--no-modify-path touched a profile"

# install.ps1 (no PowerShell here to run it): the retry wrapper and the message exist and every download goes through it
if grep -q "function Invoke-Download" "$ROOT/install.ps1" && grep -q "run the same command again" "$ROOT/install.ps1" && [ "$(grep -c "Invoke-WebRequest" "$ROOT/install.ps1")" = 1 ]; then ok "install.ps1 downloads with retry and the same-command message"; else bad "install.ps1 retry wrapper"; fi

[ ! -e "$T/home/.opencode" ] && ok "never creates ~/.opencode" || bad "created ~/.opencode"
exit $fail
