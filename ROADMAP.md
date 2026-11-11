# Roadmap and open work

Ezkielyna Agent is in beta. This list comes from the maintainers' open items; pick one, comment on (or open) the matching
issue, and send a PR. Items marked **good first issue** are small and need no deep knowledge of the codebase.

## Good first issues

1. **Run the Linux x64 CLI on a real machine** and report what works (install with `install --local`, first-run key dialog,
   a small task, `ezkielyna doctor`). So far it has only run in a Docker container. *(testing, no code needed)*
2. **Run the Linux arm64 CLI** (Raspberry Pi 4/5, an ARM VM or cloud instance): never run at all. *(testing)*
3. **Run the Windows x64 CLI and `install.ps1`** on a real Windows 10/11 PC: both are built but have never run on Windows.
   *(testing)*
4. **Run `scripts/ezk/test_all.sh` on Linux** and fix or document what fails (it was written for macOS first).
5. **Try a third-party OpenAI-compatible provider end to end** with the `provider` config shown in the README (or
   `EZKIELYNA_BASE_URL`), then document the result in `docs-ezk/en/` and `docs-ezk/`; note which Ezkielyna-only features
   degrade.
6. **Add a `typecheck` workflow** for pull requests into `main` (upstream's was removed because it targeted their runners);
   `scripts/ezk/test_all.sh --typecheck` lists the packages that are known to typecheck cleanly.
7. **Higher-resolution app icon**: the current master is 640 px, so large icon sizes are upscaled
   (`scripts/ezk/make_icons.py` regenerates all sizes from a new master). *(design)*
8. **A narrow-window pass on the desktop app** (the sidebar collapses to icons under 900 px): screenshots and fixes for
   anything that overlaps or truncates.

## Platforms and packaging

- Windows desktop (NSIS) and Linux desktop (AppImage, deb) are built in CI but have never been used on a real desktop.
- Windows keychain storage (DPAPI) is unit-tested with a recorder only; it needs a run on real Windows, plus a review of
  the `auth.json` fallback file permissions on Windows.
- macOS x64 has only run under Rosetta; a run on a real Intel Mac is wanted.
- The desktop updater (macOS in-place install, NSIS, AppImage self-replace) has not been tested against a real update server.
- Code signing: macOS builds are ad-hoc signed and Windows builds unsigned, so users see Gatekeeper/SmartScreen warnings.

## Product and design

- **Device-code login** ("Masuk dengan akun Ezkielyna", RFC 8628): the client is in the code
  (`packages/core/src/ezkielyna-login.ts`, `packages/opencode/src/plugin/ezkielyna.ts`) and appears when the server's
  features probe reports `device_login: true` or with `EZK_ACCOUNT_LOGIN=1`. The server side is not live yet; client-side
  polish and tests are welcome.
- **Safe auto-approve mode**: the permission chip offers "ask" and "auto-approve"; a safer middle mode needs an allow-list
  of commands in the permission config. The experimental permission modes (`EZK_FEATURES=+modes`) are a starting point.
- **Default model**: `auto` (the router) is the default; the fallback order lives in `EZK.defaultModelFallbacks`
  (`packages/core/src/ezkielyna-brand.ts`). Benchmarks that compare choices with `bench/` are useful input.
- **Motion-graphics skill**: the home screen has a "Motion graphic" chip marked "soon". Idea: a built-in skill that
  scaffolds an HTML/CSS/JS scene with a deterministic timeline and renders MP4 with the user's own `ffmpeg`
  (permissively licensed tools only).
- **Lighter desktop shell** (Tauri, system webview) reusing the UI package and the CLI as a sidecar; Electron is about
  228 MB of the current app. Not started.
- **Faster start-up**: lazy `import()` of server, LSP, MCP and tree-sitter in `packages/opencode/src/index.ts`.
- **Locales**: only English and Indonesian are enabled in the desktop app; other locales would need the `ezk.*` strings
  translated first.
- **OpenCode 2.x**: upstream has `v2.x` tags; decide whether and when to follow that line (we are on 1.x).

## Experimental features that need users and feedback

All off by default, switched on with `EZK_FEATURES=+name` (see `packages/core/src/ezk/flags.ts` and `docs-ezk/en/`):
sandbox (macOS Seatbelt, Linux bubblewrap), hooks, permission modes and rules, rewind, plan approval, explore subagent,
handoff, background exec, code search and repo map, compaction, the Telegram bridge.
