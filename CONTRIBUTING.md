# Contributing to Ezkielyna Agent

Thanks for helping. Issues and pull requests are welcome in English or Bahasa Indonesia.
Terima kasih sudah mau bantu. Issue dan PR boleh dalam Bahasa Indonesia atau Inggris.

## Before you start

- Look at [ROADMAP.md](ROADMAP.md) for open work; items marked `good first issue` are small and self-contained.
- For anything larger than a bug fix, open an issue first so we can agree on the approach.
- Read [docs/MODULES-EZK.md](docs/MODULES-EZK.md): it maps our own files and the few places where we edit upstream OpenCode code.
- Security problems: do **not** open a public issue, see [SECURITY.md](SECURITY.md).

## Set up

Requirements: [Bun](https://bun.sh) 1.4.3 (`packageManager` in `package.json`), git, Node.js 24 for desktop builds.

```bash
git clone https://github.com/EzkielynaGroup/ezkielyna-agent && cd ezkielyna-agent
HUSKY=0 bun install --frozen-lockfile
bun run dev                 # CLI/TUI from source
bun run dev:desktop         # desktop app in development mode
```

You need a model to talk to. Either an Ezkielyna key (`EZKIELYNA_API_KEY`), or point the built-in provider at any
OpenAI-compatible endpoint with `EZKIELYNA_BASE_URL`. Most tests need neither: they use local mock gateways.

Build steps for the CLI binary and the desktop app are in the [README](README.md#build-from-source).

## Tests

```bash
scripts/ezk/test_all.sh                 # Ezkielyna unit suites + installer tamper tests; CLI/desktop e2e when a build exists
scripts/ezk/test_all.sh --unit-only     # unit + installer tests only
scripts/ezk/test_all.sh --typecheck     # also TypeScript checks of core, opencode, app, desktop
bun script/ezk-brand-guard.ts           # brand/vendor-name guard for packages/*/src
cd packages/<name> && bun test          # one package; never run `bun test` from the repository root
```

Optional e2e inputs: `EZK_CLI_BIN=<built ezkielyna binary>` and `EZK_DESKTOP_EXE=<packaged app executable>`.
`scripts/ezk/test_all.sh` has been run on macOS arm64; running it on Linux and Windows and fixing what breaks is useful work.

Rules for tests:
- No real API calls and no real keys in tests. Use the mock gateways (`packages/core/test/ezk/mock-gateway.ts`,
  `packages/opencode/test/ezk-speed/mock-gateway.ts`, `scripts/ezk/e2e/mock_openai.ts`).
- Fake secrets in fixtures are built at runtime (for example `"sk-" + "abc..."`) so secret scanners stay quiet.
- Every bug fix comes with a test that fails without the fix.

## Branches and pull requests

- `main` is the only long-lived branch. Work on a short branch (`fix-key-dialog`, `linux-sandbox-docs`), no slashes.
- Commit messages and PR titles: `type(scope): summary`, types `feat`, `fix`, `docs`, `chore`, `refactor`, `test`
  (for example `fix(tui): keep the route badge after compaction`).
- One topic per PR. Describe what changed, why, and how you tested it (which OS).
- Keep edits to upstream OpenCode files small and mark them with a `// Ezkielyna Agent:` comment; put new behaviour in
  `ezkielyna-*` or `ezk/` files. This keeps upstream updates cheap.
- New user-visible text goes into both `packages/app/src/i18n/en.ts` and `id.ts` (the i18n parity test checks this).
- New network calls, new default-allowed permissions or new default-on features need a sentence in the PR about why.
  Experimental features go behind a flag in `packages/core/src/ezk/flags.ts`, off by default.
- CI (`.github/workflows/test.yml` and `build.yml`) must be green. Code style follows [AGENTS.md](AGENTS.md).

## Taking a new upstream OpenCode release

This repository has its own history (it does not share commits with upstream), so upstream releases are applied as a
3-way patch from the release we are based on (`scripts/ezk/UPSTREAM_BASE`, currently `v1.19.3`) to the new tag:

```bash
git remote add upstream https://github.com/anomalyco/opencode.git    # once
scripts/ezk/merge_check.sh v1.20.0 --dry     # conflict list only
scripts/ezk/merge_check.sh v1.20.0           # apply in a scratch worktree, bun install, run the unit + installer suite
scripts/ezk/merge_check.sh v1.20.0 --keep    # keep the scratch branch to resolve conflicts, then open a PR from it
```

Exit codes: 0 clean and green, 1 conflicts, 2 tests failed, 3 setup problem. Expected conflict spots and the checks to
repeat afterwards (new `opencode.ai` hosts, new default-allow permissions, new `fetch(` calls) are listed in
[docs/MODULES-EZK.md](docs/MODULES-EZK.md), section 3.

## Licence of contributions

By contributing you agree that your contribution is licensed under the MIT licence of this repository (see [LICENSE](LICENSE)).
Do not copy code from projects with incompatible licences; when you adapt an idea from another permissive project, add a
line to [NOTICE](NOTICE).
