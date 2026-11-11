# Ezkielyna Agent: module map and upstream merge procedure

Base: OpenCode v1.19.3 (MIT), recorded in `scripts/ezk/UPSTREAM_BASE`. Development happens on `main`.
Rule of thumb: **new behaviour lives in `ezkielyna-*` / `ezk/` files; edits to upstream files are small, marked
`// Ezkielyna Agent:` and listed below.** That keeps taking a new upstream release cheap (section 3).

## 1. Our own files (no upstream counterpart, never conflict)

| File | Purpose |
| --- | --- |
| `packages/core/src/ezkielyna-brand.ts` | Names, ids, URLs, model preferences (browser-safe constants) |
| `packages/core/src/ezkielyna.ts` | Gateway model discovery, default/small model choice, config defaults, ask-first permissions |
| `packages/core/src/ezkielyna-errors.ts` | Friendly ID/EN error text mapped from the gateway's real error bodies |
| `packages/core/src/ezkielyna-secrets.ts` | OS keychain (macOS Keychain, libsecret, Windows DPAPI) with 0600 file fallback |
| `packages/core/src/ezkielyna-redact.ts` | `sk-` key redaction for every log writer |
| `packages/core/src/ezkielyna-update.ts` | Signed-update verification (ECDSA P-256, pinned host, no downgrade) |
| `packages/core/src/ezkielyna-login.ts` | Device login client ("Masuk dengan akun Ezkielyna") |
| `packages/core/src/ezkielyna-account.ts` | Plan/quota/balance from store `/me` with gateway billing fallback; shared by desktop, CLI and TUI |
| `packages/core/src/ezkielyna-localkey.ts` | CLI/TUI: read the user's own key (env or auth.json + keychain) |
| `packages/opencode/src/plugin/ezkielyna.ts` | Auth plugin: API key + account login methods for the `ezkielyna` provider |
| `packages/opencode/src/cli/cmd/ezkielyna-account.ts` | `ezkielyna account` command |
| `packages/opencode/src/session/prompt/ezkielyna.txt` | Lean system prompt |
| `packages/tui/src/component/account-quota.tsx` | Quota line in the TUI footers |
| `packages/tui/src/theme/assets/ezkielyna.json` | TUI theme (store palette) |
| `packages/desktop/src/main/ezkielyna-guards.ts` | EPIPE/uncaught-error guards, friendly notification |
| `packages/desktop/src/main/ezkielyna-updater.ts` | Verified desktop updater (notify-only on unsigned macOS) |
| `packages/app/src/components/ezkielyna-sidebar.tsx` | Left sidebar: tasks, plugins, account line |
| `scripts/ezk/` | Test runner (`test_all.sh`), upstream update check (`merge_check.sh`), e2e smoke tests, mac ad-hoc signing, icon generator |
| `script/ezk-brand-guard.ts` | Fails CI when user-visible upstream branding or a private vendor name appears in `packages/*/src` |
| `docs-ezk/` | User guide (Indonesian, English under `docs-ezk/en/`) |
| `bench/` | Benchmark of 30 real coding tasks (mock gateway for dry runs) |

## 2. Touch points in upstream files (where a merge can conflict)

Search for `Ezkielyna Agent` in these; each hunk is a few lines.

* **Rebrand / paths**: `core/src/global.ts` (data dirs `ezkielyna`), `core/src/flag/flag.ts` (`EZK_*` env with `OPENCODE_*` fallback),
  `opencode/src/config/{config,paths,tui,tui-migrate}.ts` (only `.ezkielyna` dirs and `ezkielyna.json(c)`, no `~/.opencode`),
  `opencode/src/index.ts` (command list: `uninstall` and the console `account` command removed, `account` is ours), `opencode/src/cli/ui.ts`.
* **Provider / models**: `core/src/models-dev.ts` (`withEzkielyna` injection, no startup fetch), `opencode/src/provider/provider.ts`
  (`BUNDLED_PROVIDERS` cut to the OpenAI-compatible SDKs), `opencode/src/provider/error.ts`, `opencode/src/session/retry.ts`
  (friendly errors, no Go upsell), `opencode/script/{generate,build,build-node}.ts` (no models.dev snapshot, full minify, `EZK_UPDATE_URL`).
* **Security defaults**: `opencode/src/agent/agent.ts` (`ASK_FIRST_PERMISSION` in the `defaults` layer), `opencode/src/auth/index.ts`
  (keychain sentinel + migration), `opencode/src/server/auth.ts`, `opencode/src/server/shared/ui.ts` (never proxy the UI from opencode.ai),
  `opencode/src/cli/cmd/{serve,web,attach}.ts` (`EZK_SERVER_*`).
* **Updates**: `opencode/src/installation/index.ts`, `opencode/src/cli/{upgrade.ts,cmd/upgrade.ts}`, `desktop/src/main/updater.ts`.
* **Desktop shell**: `desktop/src/main/{index,windows,logging,server,sidecar,install-state,background-cli,constants,native-translations}.ts`,
  `desktop/electron-builder.config.ts`, `desktop/electron.vite.config.ts`, `desktop/package.json`, `desktop/src/renderer/*`.
* **UI**: `app/src/pages/new-session/new-session-view.tsx`, `app/src/pages/layout-new.tsx`, `app/src/context/language.tsx`
  (English and Indonesian only), `app/src/i18n/{en,id}.ts` (ezk.* keys), `ui/src/**` theme tokens and fonts.
* **TUI**: `tui/src/{app.tsx,logo.ts,attention.ts}`, `tui/src/context/theme.tsx`, `tui/src/theme/index.ts`, `tui/src/routes/session/{footer,permission}.tsx`,
  `tui/src/feature-plugins/home/{footer,tips-view}.tsx`, `tui/src/component/{dialog-model,dialog-provider,dialog-update,error-component}.tsx`.

## 2b. Integrated lanes (merged on 22 Oct 2026, before the public history starts)

| Branch | What it adds | Files that overlap our touch points |
| --- | --- | --- |
| `ezk-next` (= ezk-v2 + calib + telegram + speed + skills) | router (Auto), memory, FTS5 session search, skills queue, Telegram bridge (opt-in), speed items | `session/prompt.ts` (model.select hook, skills review, loop), `plugin/index.ts`, `httpapi/server.ts`, `ezkielyna-sidebar.tsx`, `core/src/ezk/**`, `plugin/ezk/**`, `tui/src/ezk/**`, `app/src/components/ezk/**` |
| `ezk-xplat` | Windows path guards, process tree, sqlite fallbacks | `ezkielyna-secrets.ts`, `ezk/search/sqlite.ts`, `ezk/telegram/pathguard.ts` (xplat versions kept) |
| `ezk-tests`, `ezk-brand` | test expectations, user-visible text sweep and brand guard | `providers.ts`, locale files, many tests |
| `ci-builds` (PR #2) | GitHub Actions: Linux builds on PRs, Windows/macOS CLI on dispatch and tags, test report | `.github/workflows/*`, `scripts/ci/*` |

Rules learned during the integration: `@opencode-ai/core` must stay a **devDependency** of the desktop package (as a runtime dependency electron-builder packs its whole tree),
and the desktop main process must bundle it (`externalizeDeps.exclude`). `loop()` in `prompt.ts` must not await anything before `ensureRunning` (cancel race).
The default model only prefers the Ezkielyna provider when it has credentials. Model hooks of the router must tolerate `undefined` outputs.

Everything else in the monorepo (`packages/{console,enterprise,slack,web,docs,function,...}`) is unmodified upstream code that is not built or shipped.

## 3. Taking a new upstream release

The public repository starts with a fresh history, so it shares no commits with upstream OpenCode. Upstream releases are
therefore taken as a **3-way patch** from the base release (`scripts/ezk/UPSTREAM_BASE`) to the new tag, not with `git merge`:

```
git remote add upstream https://github.com/anomalyco/opencode.git   # once
scripts/ezk/merge_check.sh v1.20.0 --dry      # conflict list only (no install)
scripts/ezk/merge_check.sh v1.20.0            # apply in a scratch worktree, bun install, run the unit + installer suite
scripts/ezk/merge_check.sh v1.20.0 --keep     # keep the scratch worktree/branch to resolve conflicts there
```

Exit codes: 0 clean and green, 1 conflicts, 2 tests failed, 3 setup problem. Your `main` branch is never touched.
After a green check, open a pull request from the scratch branch (`--keep`), which also updates `scripts/ezk/UPSTREAM_BASE`;
then `bun install`, `scripts/ezk/test_all.sh --typecheck`, rebuild (README, "Build from source") and smoke-test the builds.

Checks to repeat after every merge: `grep -rn "opencode" ` on user-visible strings (`bun script/ezk-brand-guard.ts` does this),
new default-allow permissions in `agent/agent.ts`, new network calls (`grep -rn "fetch(" ` to hosts other than our two), new default plugins.

Comments in the code sometimes cite maintainer notes that are not part of this repository (`INTEGRATION-*.md`, `REPORT-*.md`, `QUALITY.md`, `research-v3/`). They are design/test logs; the code and tests are the reference.
