# Ezkielyna Agent GitHub Action

Run [Ezkielyna Agent](https://ezkielyna.store) in your CI. Two ready-made jobs and one free-form mode:

| `mode` | What it does | Default `permission-mode` |
|---|---|---|
| `review` | Reviews the pull request diff and posts **one** comment (updated on every push). Read only. | `plan` |
| `fix-ci` | Reads the log of a failed job and opens a **draft pull request** with a proposed fix on a new branch `ezkielyna/fix-ci-…`. Never pushes to the pull request's own branch or to the default branch. | `acceptEdits` |
| `custom` | Runs your `prompt`. | `plan` |

The action installs the CLI with the signed installer from `https://ezkielyna.store/agent/install.sh` and drives `ezkielyna exec --json`. **Linux runners only** (`ubuntu-latest`); on macOS or Windows it stops with a clear error.

## Quick start

1. Create an API key at <https://api.ezkielyna.store/keys> and save it as the repository secret `EZKIELYNA_API_KEY` (Settings → Secrets and variables → Actions). Never write the key in a workflow file.
2. Copy [`examples/review-on-PR.yml`](examples/review-on-PR.yml) to `.github/workflows/` in your repository.

```yaml
permissions:
  contents: read
  pull-requests: write      # needed to post and update the review comment
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0, persist-credentials: false }
  - uses: ezkielyna/agent-action@v1.0.0
    with:
      api-key: ${{ secrets.EZKIELYNA_API_KEY }}
      mode: review
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `api-key` | required | Your Ezkielyna key. Masked in logs with `::add-mask::`, passed to the CLI only through its environment. |
| `mode` | `custom` | `review`, `fix-ci` or `custom`. |
| `prompt` | | The task for `custom`. For `review` and `fix-ci`, extra context from you. |
| `model` | `ezk-auto` | A model name, or `ezk-auto` to let the router choose. |
| `max-budget` | `0.50` | Stop when the run costs more than this many US dollars (1 cent to 100 USD). |
| `max-turns` | CLI default | Stop after this many model turns (1 to 500). |
| `permission-mode` | by mode | `ask`, `plan`, `acceptEdits` or `safeAuto`. `full` is refused. |
| `version` | `latest` | Agent version to install, for example `1.19.3-ezk.3`. Pin it in production. |
| `github-token` | `github.token` | Used to comment or to open the draft pull request. |
| `log-file` | | `fix-ci`: a file with the failing log. If empty, the failed jobs of `run-id` are downloaded. |
| `trust-project` | `false` | `fix-ci`: DANGEROUS. Keep the failing branch's own project config instead of resetting it to the default branch. See the security notes. |
| `run-id` | triggering run | `fix-ci`: the workflow run that failed. |

## Outputs

| Output | Meaning |
|---|---|
| `result` | The final message of the agent. |
| `cost-usd` | Cost in US dollars; empty if the CLI did not report it. |
| `turns` | Number of model turns. |
| `exit-code` | `0` ok, `1` error, `2` stopped by `max-turns`/`max-budget`, `3` an action was denied by the permission mode. |

Exit `1` fails the step. Exits `2` and `3` only warn; read `exit-code` if you want to react. A job summary (mode, model, turns, cost, tokens, exit code, result) is always written.

## Permissions

| Mode | `permissions:` |
|---|---|
| `review` | `contents: read`, `pull-requests: write` |
| `fix-ci` | `contents: write`, `pull-requests: write`, `actions: read`; enable "Allow GitHub Actions to create and approve pull requests" in the repository settings |
| `custom` | `contents: read` |

## Security notes

- The diff and the CI log are untrusted text. The prompts tell the agent to treat them as data, and `review` runs read only (`plan`).
- `fix-ci` marks its checkout as trusted for the CLI process only for edits (otherwise `exec` answers every edit request with "deny" in a folder nobody ran `ezkielyna trust` for). Before the agent starts, the project config of the failing branch (`ezkielyna.json*`, `.ezkielyna/`, `.mcp.json` and the legacy-named config files and folders) is restored from the default branch, or deleted when the default branch has none, and those paths are never committed to the draft pull request. Otherwise a pushed branch could ship a plugin or MCP server that runs with your API key. The example skips fork pull requests. `review` never trusts the folder and stays read only.
- **Warning, `trust-project: true`**: skips that reset and lets the checked-out branch's own config run with your API key. Leave it `false` (the default) unless every branch that can fail CI is reviewed code.
- The reset also covers symlinked config folders and the other tools' instruction folders that the agent reads. Instruction files such as `AGENTS.md` from the checked-out branch are still honoured as prompt text (like the CI log, treat them as untrusted input).
- Use `persist-credentials: false` on `actions/checkout` (the examples do). Without it the repo token stays in `.git/config` and the agent can read it.
- Do not run this action on `pull_request_target` with a checkout of the fork's code: secrets and a write token would meet untrusted code. The example skips fork pull requests.
- `fix-ci` pushes only to a new branch that starts with `ezkielyna/`, never the failing branch and never the default branch, and it never commits files under `.github/workflows/`. You merge the draft pull request yourself.
- Always keep `max-budget` set.

## Testing without a key

`EZK_ACTION_DRY_RUN=1` skips the install and every GitHub call, and uses whatever `ezkielyna` is first in `PATH`. `test/fake-bin/ezkielyna` is a fake that prints canned `exec --json` events. Run `bun test` in this folder.

---

# Bahasa Indonesia (ringkas)

Action ini menjalankan Ezkielyna Agent di CI GitHub Anda, hanya di runner Linux.

- **`mode: review`**: memeriksa diff pull request dan memasang **satu** komentar (diperbarui setiap push). Hanya membaca.
- **`mode: fix-ci`**: membaca log job yang gagal lalu membuka **draft pull request** berisi usulan perbaikan di cabang baru `ezkielyna/fix-ci-…`. Tidak pernah mendorong ke cabang pull request itu sendiri atau cabang utama.
- **`mode: custom`**: menjalankan `prompt` Anda.

Langkah awal: buat kunci di <https://api.ezkielyna.store/keys>, simpan sebagai secret repositori `EZKIELYNA_API_KEY`, lalu salin `examples/review-on-PR.yml` ke `.github/workflows/`. Izin minimal untuk review: `contents: read` dan `pull-requests: write`. Selalu isi `max-budget` (bawaan 0,50 USD) dan sematkan `version` di produksi. Kunci tidak pernah dicetak; nilainya disamarkan dengan `::add-mask::`.
