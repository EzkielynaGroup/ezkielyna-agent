# Ezkielyna Agent: security review (21 Oct 2026)

Scope: the desktop app (Electron), the CLI/TUI binary, the local server they start, key storage, updates and installers.
Method: code reading of the touch points in `docs/MODULES-EZK.md`, empirical checks against the built binaries, and regression tests
for every fix (test names in brackets). Items marked FIXED were found during this review.

## 1. Local server

| Check | Result |
| --- | --- |
| Bind address | `127.0.0.1` only by default. Verified with `lsof` (listening on 127.0.0.1) and a connection attempt from the machine's LAN IP (refused). `0.0.0.0` and mDNS only with explicit flags. |
| Desktop sidecar | Random free port, random per-launch password in `EZK_SERVER_PASSWORD`, basic auth user `ezkielyna`, loopback host enforced in `desktop/src/main/sidecar.ts`. |
| `ezkielyna serve` / `web` without a password | **FIXED.** Upstream ran an unauthenticated server (any local program, or a web page via a simple cross-origin POST, could drive the agent). Now a random password is generated for the run and printed once (`cli/ezkielyna-server-password.ts`). |
| Server auth variable | Only `EZK_SERVER_PASSWORD/USERNAME` are read by the server; the upstream `OPENCODE_*` names are not honoured by the server (they are by the client flag as a fallback only). [`test/server/*auth*`] |
| Web UI proxy | Never proxied from `app.opencode.ai` unless `EZK_UI_PROXY=1`. |

## 2. Permissions and tool restrictions

| Check | Result |
| --- | --- |
| Defaults | "Ask before acting": edits, web fetches and shell commands ask; a short exact-string read-only bash list is allowed (`ls`, `pwd`, `git status/diff/log` ...; no wildcards, because a wildcard also matches a trailing redirect). Defined once as `ASK_FIRST_PERMISSION` and used as the lowest layer of every agent. |
| Plan and explore agents | **FIXED during development:** the first version put the ask-first rules into the user-config layer, which silently overrode the plan/explore agents' own `deny` rules. Caught by the upstream agent tests, moved to the agents' `defaults` layer. [`test/agent/agent.test.ts`] |
| Paths outside the project | `external_directory` asks (upstream default kept); reading `.env` files asks; temp/skill dirs allowed. [`test/permission`] |
| Non-interactive `run` | Permission requests are auto-rejected unless `--auto` is passed. [`test/cli/run`] |

## 3. Opening someone else's folder (project trust) — FIXED

Upstream applies a project's `opencode.json` and `.opencode/` directory as soon as you open the folder. That lets a cloned repository
run code (plugins, custom tools, local MCP servers, formatters, LSP commands, command templates), widen permissions
(`permission: {bash: allow}`) or redirect the API key (`provider.<id>.options.baseURL`).

Now: an untrusted project only keeps a short allow-list of harmless keys (`model`, `small_model`, `default_agent`, `instructions`,
`theme`, `snapshot`, `compaction`, `username`, `logLevel`, `$schema`). Everything else is dropped with a log line, and the project's
`.ezkielyna/` directory is ignored. `ezkielyna trust [dir]` (and `--revoke`, `--status`) adds a folder to
`~/.config/ezkielyna/trusted-projects.json` (mode 0600; real paths, so a symlink cannot smuggle an untrusted folder under a trusted one).
[`core/test/ezkielyna/trust.test.ts`] Limits: the desktop app **does** show a trust banner for an untrusted folder ("Trust this folder", `trust.ui` is ON by default; `core/src/ezk/flags.ts`), and `ezkielyna trust` remains available in the CLI. `--permission-mode` in an untrusted folder now prints a warning in `run` and `exec` (`opencode/src/ezk/trust-notice.ts`), and `AGENTS.md` / `CLAUDE.md` from an untrusted folder are not sent to the model (`opencode/src/session/instruction.ts`). Global config
(`~/.config/ezkielyna`) is always trusted because only the user writes it.

## 4. Plugins, MCP and installers

* Plugins come only from the user's global config, a trusted project, or `ezkielyna plug <pkg>` typed by the user. Npm is contacted
  only when a config directory actually declares plugins/tools.
* MCP servers are user-initiated (`ezkielyna mcp add`, or the Plugins dialog). OAuth registration now identifies as "Ezkielyna Agent"
  (was "OpenCode"). Remote MCP tools go through the same permission prompts as built-in tools.
* Upstream installers (npm/brew/choco/scoop/bun upgrade paths, the OpenCode 2 offer, `uninstall`, the VS Code extension installer) were
  removed or disabled: they would replace this app with the upstream product or delete the user's upstream install.
* Our installers verify an offline ECDSA P-256 signature of `latest.json`/`SHA256SUMS`, then the archive hash. [`scripts/ezk/e2e/installer_test.sh`: tampered archive, tampered manifest, wrong key, unlisted archive, missing signature all refused]

## 5. Keys and secrets

* The API key is stored in the OS keychain (macOS Keychain via `security -i` stdin, libsecret, Windows DPAPI); `auth.json` holds only a
  sentinel, with a 0600 file fallback when no keychain exists. A key that is saved in the keychain but cannot be read (locked or denied) is reported as such, no longer as "No API key" (app commit `e559572bd1`). Plain-text keys from earlier runs migrate on first read. [`core/test/ezkielyna/secrets.test.ts`, `opencode/test/auth/auth.test.ts`]
* Every log writer redacts `sk-` tokens (`ezkielyna-redact.ts`); crash dialogs and bug text pass through the same filter.
* The release signing private key is kept offline by the maintainer and is not in this repository; the apps and installers embed the public key.
* The account-quota calls send the user's own key only to `api.ezkielyna.store` and `ezkielyna.store`, over HTTPS.
* The router reads one public JSON document, `https://ezkielyna.store/agent/model-policy.json` (model chains, context sizes, prices; no key is sent, 3 s timeout, 1 h cache, falls back to built-in defaults).
* No telemetry: Sentry upload is disabled, there is no analytics call, `models.dev` is not contacted at startup.

## 6. Updates

HTTPS only, host pinned to `ezkielyna.store`, strictly-newer semver (no downgrade), detached signature, SHA-256 and size checks
before anything runs. macOS: when the app is in /Applications (an ad-hoc-signed bundle in a writable, non-translocated location) the update is installed in place; in any other location the app opens the signed `downloadPage` instead (`desktop/src/main/ezkielyna-updater.ts`). Windows installs silently from the verified file; Linux AppImage replaces itself.
[`core/test/ezkielyna/update.test.ts`, `desktop/src/main/ezkielyna-updater.test.ts`]

## 7. Electron shell

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; `will-navigate` and `window.open` go through a URL policy
(external links open in the system browser, `file:`/custom schemes are checked); permission requests are granted only to the app's
own renderer; main-process startup errors show a short friendly dialog instead of the raw Electron one (`desktop/src/main/boot.ts`).

## 8. Known limits

* Prompt injection from file contents or web pages can still persuade the model to ask for dangerous actions; the permission prompt is
  the control, so approving shell commands needs reading them.
* The desktop app and macOS builds are unsigned (ad-hoc signed): Gatekeeper/SmartScreen warnings are expected until certificates exist.
* Custom OpenAPI descriptions and model-facing system prompts were rebranded, but third-party providers' own prompts are theirs.
* Windows keychain storage (DPAPI) is implemented and unit tested with a recorder, not yet run on a real Windows machine.
