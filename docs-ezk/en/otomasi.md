# Automation: `ezkielyna exec`

`ezkielyna exec` runs one task without the chat screen and then stops. Use it in scripts and in CI (for example GitHub Actions). `ezkielyna run` still works as before; `exec` is the one with a stable output format.

```bash
ezkielyna exec "fix the failing test in src/cart.test.ts"
echo "explain this repo in 5 lines" | ezkielyna exec -
```

Without `--json`, progress (commands, changed files) is printed on stderr and only the final answer on stdout, so `answer=$(ezkielyna exec "...")` works.

## Options

| Option | What it does |
|---|---|
| `--json` | One JSON event per line on stdout, in a JSON format compatible with other automation tools: `thread.started`, `turn.started`, `turn.completed` (with token usage), `turn.failed`, `item.started` / `item.updated` / `item.completed` and `error`. Items: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`. Any ordinary JSONL reader can read it. |
| `--output-schema <file>` | A JSON Schema file. The final answer must be JSON that matches it. If it does not, the agent is asked once to fix it; if it is still wrong, the exit code is 1. |
| `-o`, `--output-last-message <file>` | Writes the final answer to a file. |
| `--max-turns <n>` | Stops after `n` model turns (exit code 2). |
| `--max-budget <usd>` | Stops when the estimated cost of this run reaches this amount in US dollars (exit code 2). The estimate uses the same price list as Auto (Pintar). |
| `--permission-mode <mode>` | What happens when a tool needs approval (nobody can be asked here): `ask` (default: refuse), `acceptEdits` (file changes inside the project are allowed, commands are refused), `plan` (read only), `safeAuto` (same as `acceptEdits` here), `full` (everything is allowed; only in a throwaway CI machine). The Indonesian names work too: `tanya-dulu`, `edit-otomatis`, `otomatis-aman`, `rencana`, `penuh`. In an **untrusted folder** (`ezkielyna trust`) every request is refused whatever the mode, and changes to **protected folders** (`.git`, `.ezkielyna`, `ezkielyna.json`, `.github/workflows` and the like) are refused even with `full`. |
| `--resume <id>` | Continues an earlier session. The id is `thread_id` from `thread.started`. |
| `--cwd <folder>` (also `--cd`, `-C`) | The project folder to work in. Without it, the current folder of the process is used. |
| `-m provider/model`, `--agent`, `--variant` | As in `ezkielyna run`. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Finished. |
| 1 | Error (gateway error, no session, or the answer did not match `--output-schema`). |
| 2 | Stopped by `--max-turns` or `--max-budget`. |
| 3 | Finished, but at least one action was refused by `--permission-mode`. |

## Behavior and security notes

- **`full` mode** approves (once per request) everything that is not a change to a protected folder, including access to folders outside the project (`external_directory`) and requests to leave the sandbox (`sandbox_escalation`). That is why `full` only works in a trusted folder and the GitHub Action does not allow it. Use it only on a throwaway CI machine.
- **Command timeout (unified `exec` feature, off by default).** A foreground command is only stopped by a timeout when you pass an explicit `timeout`. The default timeout is not applied to foreground commands; a command that outlives the wait window continues as a background task that you can read with `write_stdin` and stop with `exec_stop`.
- **`fix-ci` in the GitHub Action** restores the failing branch's project config (`ezkielyna.json*`, `.ezkielyna/`, `.mcp.json` and the legacy-named config files) from the default branch before the agent runs, and never puts those files in the draft pull request. The input `trust-project: true` turns this off; do not use it unless every branch is reviewed. Use `persist-credentials: false` on `actions/checkout`.

## GitHub Actions example

Store your key as a repository secret named `EZKIELYNA_API_KEY` (Settings → Secrets and variables → Actions). Never write the key in the workflow file.

```yaml
name: ezkielyna review
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Install Ezkielyna Agent
        run: |
          curl -fsSL https://ezkielyna.store/agent/install.sh | sh
          echo "$HOME/.ezkielyna/bin" >> "$GITHUB_PATH"
      - name: Check the change
        env:
          EZKIELYNA_API_KEY: ${{ secrets.EZKIELYNA_API_KEY }}
        run: |
          cat > schema.json <<'EOF'
          { "type": "object",
            "properties": { "ok": { "type": "boolean" }, "problems": { "type": "array", "items": { "type": "string" } } },
            "required": ["ok", "problems"] }
          EOF
          ezkielyna exec --json --permission-mode plan --max-turns 30 --max-budget 0.50 \
            --output-schema schema.json -o result.json \
            "Review the changes in this pull request against main. List real bugs only." > events.jsonl
          cat result.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ezkielyna-events
          path: events.jsonl
```

Tips:
- Start with `--permission-mode plan` (read only). Use `acceptEdits` only when the job should change files, and `full` only on a throwaway runner.
- Always set `--max-budget` in CI.
- `jq -c 'select(.type=="item.completed")' events.jsonl` shows only finished steps.

## Use it in GitHub Actions

A ready-made action is in the `github-action/` folder of our repository (publishing it to the Marketplace is not done yet; the name `ezkielyna/agent-action@v1.0.0` below is still an example). It installs Ezkielyna Agent with the signed installer and runs `ezkielyna exec --json`. Linux runners only (`ubuntu-latest`).

- `mode: review`: reviews the pull request diff and posts **one** comment, updated on every push. Permissions: `contents: read`, `pull-requests: write`.
- `mode: fix-ci`: reads the failed job log and opens a **draft pull request** on a new `ezkielyna/fix-ci-…` branch. It never pushes to the pull request's branch or the default branch. Permissions: `contents: write`, `pull-requests: write`, `actions: read`.

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: ezkielyna/agent-action@v1.0.0
  with:
    api-key: ${{ secrets.EZKIELYNA_API_KEY }}
    mode: review
    max-budget: "0.50"
```

Store the key as the secret `EZKIELYNA_API_KEY`; it is masked in logs. Outputs: `result`, `cost-usd`, `turns`, `exit-code`. Full examples are in `github-action/examples/`.
