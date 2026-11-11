# Ezkielyna Agent

An open-source AI coding agent for the terminal and the desktop, preconfigured for the
[Ezkielyna AI API gateway](https://api.ezkielyna.store). It is a fork of [OpenCode](https://github.com/anomalyco/opencode)
v1.19.3 (MIT) with privacy-first defaults, an Indonesian + English interface and a few agent features of its own.

> **Status: beta.** The current line is `1.19.3-ezk.x`. macOS on Apple Silicon is the only platform that is used and
> tested day to day. Help on Linux and Windows is very welcome, see [ROADMAP.md](ROADMAP.md).

> Based on OpenCode (MIT). **Not affiliated with or endorsed by the OpenCode / SST team.** See [NOTICE](NOTICE).

## What is in this tree

Two products are built from this repository:

- **CLI + TUI**: one `ezkielyna` binary (the release archives add an `ezk` alias) with OpenCode's full terminal UI.
- **Desktop app** (Electron): OpenCode's desktop app with an Ezkielyna sidebar, home screen and theme.

What Ezkielyna Agent adds on top of OpenCode (all of it is in `packages/*/src/**/ezk*` and `packages/core/src/ezk/`,
see [docs/MODULES-EZK.md](docs/MODULES-EZK.md)):

| Feature | Default | Where |
| --- | --- | --- |
| Ezkielyna provider: models discovered from the gateway's `GET /v1/models` with your key, friendly ID/EN error messages | on | `packages/core/src/ezkielyna.ts`, `ezkielyna-errors.ts` |
| **Auto (Pintar)** router: picks a light or heavy model per message, circuit breaker per model, one in-request fallback, per-session cost cap ($1) | on | `packages/core/src/ezk/router/` |
| Memory (`MEMORY.md` / `USER.md`, secret and prompt-injection scanner, private sessions, one-step wipe) | on | `packages/core/src/ezk/memory/` |
| Full-text search over past sessions (SQLite FTS5) | on | `packages/core/src/ezk/search/` |
| `web_search` tool through the gateway (offered only when a key exists) | on | `packages/core/src/ezk/websearch/` |
| Skills | on | `packages/core/src/ezk/skills/` |
| "Ask before acting" permissions, protected paths, environment scrubbing for child processes | on | `packages/core/src/ezkielyna.ts`, `ezk/safety/` |
| Project trust: an untrusted folder cannot run plugins/MCP/tools from its config or widen permissions (`ezkielyna trust`) | on | see [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) |
| API key in the OS keychain (macOS Keychain, libsecret, Windows DPAPI) with a 0600 file fallback; `sk-` redaction in every log | on | `ezkielyna-secrets.ts`, `ezkielyna-redact.ts` |
| Signed updates (offline ECDSA P-256 manifest signature, pinned host, no downgrade) and signed `install` / `install.ps1` | only when built with `EZK_UPDATE_URL` | `ezkielyna-update.ts`, `install`, `install.ps1` |
| `ezkielyna exec` (non-interactive runs for scripts/CI), `ezkielyna doctor`, `ezkielyna account`, `ezkielyna memory`, `/review` | available | `packages/opencode/src/ezk/`, `cli/cmd/` |
| Experimental, off by default: sandbox (macOS Seatbelt, Linux bubblewrap), hooks, permission modes, rewind, plan approval, explore subagent, code search / repo map, Telegram bridge to your own bot | off | `packages/core/src/ezk/flags.ts` (`EZK_FEATURES=+name`) |

User guide: [docs-ezk/en/](docs-ezk/en/mulai.md) (English) and [docs-ezk/](docs-ezk/mulai.md) (Bahasa Indonesia).

## Privacy defaults

- **No telemetry.** No Sentry DSN, no analytics call; the crash reporter writes locally only.
- OpenCode's session sharing, OpenCode Zen/Go providers, changelog fetch, the UI proxy to `app.opencode.ai`, the
  `github`/`console` commands and the models.dev startup fetch are switched off or removed.
- With the defaults, the app talks to Ezkielyna hosts only: `api.ezkielyna.store` (models, chat, web search) and
  `ezkielyna.store` (public router policy JSON `agent/model-policy.json`, account/quota line, update check when enabled).
- **Auto-update is off in a source build**: there is no update check at all unless the build sets `EZK_UPDATE_URL`.
- Things that reach third parties **only when you use them**: MCP servers you add, the `webfetch` tool, LSP/formatter
  downloads, other providers you configure, npm when a config folder declares plugins, the Telegram bridge.

Details: [docs-ezk/en/privasi.md](docs-ezk/en/privasi.md), [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

## Using it

### With an Ezkielyna key

1. Get a key (`sk-...`) at <https://api.ezkielyna.store/keys>.
2. Start `ezkielyna` (or the desktop app). The first run asks for the key; you can also set `EZKIELYNA_API_KEY`.
3. Pick **Auto (Pintar)** or any model your key allows.

### With another OpenAI-compatible provider

The code is built around the Ezkielyna gateway, but it is not locked to it:

- `EZKIELYNA_BASE_URL=https://your-endpoint/v1` points the built-in provider at any OpenAI-compatible endpoint
  (the model list then comes from that endpoint's `/v1/models`). Gateway-specific extras (Auto router policy,
  account/quota line, `web_search`, memory reviewer) assume Ezkielyna's API and may not work elsewhere.
- OpenCode's own custom-provider config still works for OpenAI-compatible endpoints: only the `@ai-sdk/openai` and
  `@ai-sdk/openai-compatible` SDKs are bundled (the other vendor SDKs were removed to keep the app small).
  Put the provider in `~/.config/ezkielyna/ezkielyna.json`, for example:

  ```jsonc
  {
    "provider": {
      "myprovider": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "My provider",
        "options": { "baseURL": "https://example.com/v1", "apiKey": "{env:MY_PROVIDER_KEY}" },
        "models": { "my-model": { "name": "My model" } }
      }
    }
  }
  ```

  This path is covered by OpenCode's provider unit tests; we have not run it end to end against a third-party provider
  yet (a good first issue, see [ROADMAP.md](ROADMAP.md)).

## Build from source

Requirements: [Bun](https://bun.sh) **1.4.3** (the version in `package.json` `packageManager`), git, Node.js 24 (what CI uses) for the
desktop build, and on macOS the Xcode command line tools. A full `bun install` needs several GB of disk.

```bash
git clone https://github.com/EzkielynaGroup/ezkielyna-agent && cd ezkielyna-agent
HUSKY=0 bun install --frozen-lockfile

# Run the CLI/TUI from source
bun run dev

# CLI binary for this machine -> packages/opencode/dist/<os>-<arch>/bin/ezkielyna
cd packages/opencode
OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.19.3-ezk.dev bun run script/build.ts --single
# all five targets: EZK_TARGETS="darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64" bun run script/build.ts
# (this step may rewrite bun.lock; run `git checkout bun.lock` afterwards)

# Desktop app
cd ../desktop
OPENCODE_CHANNEL=prod OPENCODE_VERSION=1.19.3-ezk.dev bun run build
OPENCODE_CHANNEL=prod bun run package:mac --arm64          # or package:linux / package:win
../../scripts/ezk/adhoc-sign-mac.sh dist arm64 1.19.3-ezk.dev   # macOS only: ad-hoc sign + rebuild zip/dmg
```

Set `EZK_UPDATE_URL=https://<host>/agent/update` at build time only if you host your own signed update feed
(see `packages/core/src/ezkielyna-update.ts`); leave it unset for a build without update checks.

### What has been tested where

| Artifact | Built | Run-tested |
| --- | --- | --- |
| CLI + TUI, macOS arm64 | yes | **yes**: daily use, e2e smoke, real tasks |
| Desktop, macOS arm64 | yes | **yes**: packaged smoke test, real tasks |
| CLI + Desktop, macOS x64 | yes | only under Rosetta on Apple Silicon, never on an Intel Mac |
| CLI, Linux x64 | yes | only the automated smoke test inside a Docker container |
| Desktop, Linux x64 (AppImage, deb) | yes (CI) | only the automated smoke test under Xvfb in Docker, never on a real desktop |
| CLI, Linux arm64 | yes | **no** |
| CLI + Desktop, Windows x64 | yes (CI) | **no**, never run on a real Windows PC; `install.ps1` never run |

The macOS builds are ad-hoc signed, not notarized; Windows builds are unsigned. Expect Gatekeeper/SmartScreen warnings.

## Tests

```bash
scripts/ezk/test_all.sh               # Ezkielyna unit suites + installer tamper tests (+ CLI/desktop e2e when built)
scripts/ezk/test_all.sh --typecheck   # also the TypeScript checks
bun script/ezk-brand-guard.ts         # no user-visible upstream branding / private vendor names in packages/*/src
cd packages/<name> && bun test        # one package (do not run tests from the repository root)
```

CI (`.github/workflows/test.yml`, `build.yml`) runs the Linux test suite and builds on pull requests into `main`.

## Contributing

Issues and pull requests are welcome, in English or Bahasa Indonesia. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and
the `good first issue` list in [ROADMAP.md](ROADMAP.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report
security problems privately as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). OpenCode is Copyright (c) 2025 opencode; the Ezkielyna changes are
Copyright (c) 2026 Ezekiel Lieberhart (Ezkielyna). Some modules adapt ideas from OpenAI Codex (Apache-2.0,
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)) and MiniMax Code (MIT), as listed in NOTICE. Fonts are under the SIL OFL 1.1.

---

## Bahasa Indonesia

**Ezkielyna Agent** adalah agen AI untuk coding di terminal (CLI/TUI) dan desktop, hasil fork dari OpenCode v1.19.3 (MIT),
yang sudah disetel untuk gateway API Ezkielyna (`https://api.ezkielyna.store`). Status: **beta**; yang diuji sehari-hari
baru macOS Apple Silicon. Proyek ini **tidak berafiliasi dengan dan tidak didukung oleh tim OpenCode/SST**.

- **Privasi:** tanpa telemetri; secara bawaan hanya menghubungi `api.ezkielyna.store` dan `ezkielyna.store`;
  build dari source tidak pernah mengecek update kecuali di-build dengan `EZK_UPDATE_URL`.
- **Pakai:** buat key di <https://api.ezkielyna.store/keys>, jalankan `ezkielyna`, masukkan key, pilih **Auto (Pintar)**.
  Provider lain yang kompatibel OpenAI bisa lewat `EZKIELYNA_BASE_URL` atau konfigurasi `provider` (lihat di atas).
- **Build:** butuh Bun 1.4.3; `bun install`, lalu `bun run dev` (lihat bagian "Build from source").
- **Panduan pengguna:** [docs-ezk/](docs-ezk/mulai.md).
- **Ikut bantu:** baca [CONTRIBUTING.md](CONTRIBUTING.md) dan daftar `good first issue` di [ROADMAP.md](ROADMAP.md).
  Issue dan PR boleh dalam Bahasa Indonesia atau Inggris. Yang paling dibutuhkan: uji di Linux dan Windows.
