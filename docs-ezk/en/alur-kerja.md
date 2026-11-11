# Workflow: rewind, plans, background work and automation

Sections 1 to 5 are **(experimental, off by default)**; sections 6 and 7 are on. The mark **(coming soon)** means it is not in this version yet.

> **Note for this version.** Sections 1 to 4 (experimental, off by default) exist in the code but are switched on with a flag and do not turn on by themselves:
> ```
> EZK_FEATURES="+rewind,+planApproval,+handoff,+subagents"
> ```
> Section 5 (background tasks) is switched on with `EZK_FEATURES=+exec` (experimental, off by default). Sections 6 and 7 are on without a flag.

## 1. Checkpoints and `/rewind` (experimental, off by default: `+rewind`)

Each time you send a message, the app has already saved the state of your project files just before the assistant starts working. That is a **checkpoint**. There is no extra copy: the app uses the snapshot it already takes, and old snapshots are cleaned up after 7 days. The newest 100 checkpoints are offered.

Open it with `/rewind`, or press **Esc** twice while the session is idle (on desktop: the **Rewind** button on each message). Pick a message, then pick what to take back:

| Choice | What happens |
|---|---|
| **Files only** | Files the assistant changed after the checkpoint are restored (or deleted if they did not exist). The chat stays. Can be undone ("Undo the last file restore"). |
| **Chat only** | The turns after that point are hidden. Files are not touched. `/redo` brings them back. |
| **Both** | Files and chat. `/redo` restores both. |
| **Summarize from here** | The turns after that point are replaced by one summary message (about 250 words at most). **Cannot be undone**, so the app asks once more. If making the summary fails, nothing changes. |

Example: the assistant changed five files and the result is wrong. Open `/rewind`, pick your message from before that, choose **Files only**. The five files go back to how they were.

Important: files that **you** changed after the checkpoint are not overwritten. The app skips them and shows a warning with the list.

## 2. Plan approval (experimental, off by default: `+planApproval`)

In **Rencana** mode the assistant only reads and writes a plan. When the plan is ready, a card appears with four choices:

- **Setujui & jalankan (Edit otomatis)** (approve and run): the plan is saved, a task list is made from the numbered steps, and the assistant starts working. File changes inside the project run without asking; commands and the web still ask.
- **Setujui & tanya tiap langkah** (approve and ask at each step): the same, but every change asks.
- **Lanjut merencanakan** (keep planning): go back to discussing.
- **Edit rencana** (edit the plan): change the plan text first.

The plan is saved in the app's data folder, **not in your project**. If the conversation is compacted later, the approved plan is added back so it is not lost. In an untrusted folder, "Edit otomatis" does not apply and the app keeps asking.

## 3. `/handoff` (experimental, off by default: `+handoff`)

A long session gets heavy. Type `/handoff <next goal>`, for example `/handoff continue with the payment page`. The app creates a **new** session and fills its message box with a starting prompt (written by a fast model from a digest of the old session) plus a list of the important files (at most 15, as `@file`). You can edit it before sending. If the model fails, the new session still opens with your goal and the file list.

## 4. The Explore subagent (experimental, off by default: `+subagents`)

For searching a big project, the assistant can call a helper named **Explore**: it only reads, works at most 4 turns, uses the cheapest fast model your key has, and answers with `path:start-end note` lines. Its result is cut to about 2,000 tokens.

- The helper only becomes available after the assistant has read or searched 3 or more times in one message, or when you write `@explore`. Short messages do not change at all.
- At most 3 helpers run at once, and helpers do not call other helpers.
- Your own helpers: `.md` files in `.ezkielyna/agents/` or `.claude/agents/` (from a project only if the folder is trusted). Read-only by default.

## 5. Running in the background (experimental, off by default: `+exec`)

Until now a command was stopped after 2 minutes. With this feature, a long command (a dev server, a long build) keeps running and the assistant can check on it later.

- A command that is not finished after about 10 seconds returns a session number and keeps running.
- The assistant can type into that command, list them, or stop them. Typing asks the same permission as the original command.
- New output is sent to the assistant on its next turn.
- Limits: 16 processes at a time, 1 MiB of output per process, and a process nobody touched for 30 minutes is stopped. When the session is deleted or the app closes, all processes and their children are stopped.
- With `+sandbox`, background commands run in the sandbox too, like normal commands.
- The terminal has `/tasks`; the desktop has a **Background tasks** row in the sidebar, both with a Stop button.

## 6. `ezkielyna exec`: for scripts and CI

`ezkielyna exec` runs one task without the chat screen and then stops. Good for scripts and CI.

```
ezkielyna exec "fix the failing test in src/cart.test.ts"
echo "explain this repo in 5 lines" | ezkielyna exec -
```

Without `--json`, progress goes to stderr and only the final answer to stdout.

| Option | What it does |
|---|---|
| `--json` | One JSON event per line: `thread.started`, `turn.started`, `turn.completed` (with token usage), `turn.failed`, `item.*`, `error`. |
| `--output-schema file` | The final answer must be JSON that matches that schema. If it does not, the agent is asked to fix it once; if still wrong, exit code 1. |
| `-o file` | Write the final answer to a file. |
| `--max-turns n` | Stop after n model turns (exit 2). |
| `--max-budget usd` | Stop when the estimated cost reaches that amount (exit 2). |
| `--permission-mode` | Nobody can be asked, so: `ask` (default, refuses), `acceptEdits`, `plan`, `safeAuto`, `full` (only on a throwaway machine). The names and meanings are the same as in the app (`auto` means `safeAuto`). In an **untrusted folder** (`ezkielyna trust`) every request is refused whatever the mode, and changes to **protected folders** (`.git`, `.ezkielyna`, `ezkielyna.json`, `.github/workflows` and the like) and commands that mention them are always refused, `full` included. |
| `--resume id` | Continue an earlier session (`thread_id` from `thread.started`). |
| `--cwd folder` | Working folder. |

Exit codes: **0** finished, **1** error, **2** stopped by the turn or cost limit, **3** finished but an action was refused by the permission mode.

### CI example (GitHub Actions)

Store your key as a repository secret named `EZKIELYNA_API_KEY`. **Never** write the key in the workflow file.

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
          ezkielyna exec --json --permission-mode plan --max-turns 30 --max-budget 0.50 \
            -o result.txt \
            "Review the changes in this pull request against main. List real bugs only." > events.jsonl
          cat result.txt
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ezkielyna-events
          path: events.jsonl
```

Tips: start with `plan` (read only); always set `--max-budget` in CI; `jq -c 'select(.type=="item.completed")' events.jsonl` shows only finished steps. A ready-made GitHub Action to review PRs or fix CI is in the `github-action/` folder of our repository; publishing it to the Marketplace is not done yet (coming soon).

## 7. `ezkielyna doctor`, `/context`, `/usage`

**`ezkielyna doctor`** checks your installation and prints one line per check: version, API key (only "found" and from where, **never the key itself**), connection and its speed, model list, settings files, folder trust status, free disk space and update channel. Add `--json` for machines. The exit code is 1 only when a check fails. Example:
```
✓ API key          found (from the EZKIELYNA_API_KEY environment variable)
✓ Connection       reachable (2 ms)
! This folder      not trusted (/home/me/project): project instructions and hooks are ignored. Run `ezkielyna trust` if you wrote it.
```
`✓` means good, `!` is a warning (does not fail), `✗` means failed.

**`/context`** (terminal) shows what the last request to the model contained: system prompt, tools, project instructions, memory and messages, each in tokens and as a percent of the model's window. The split is estimated, then scaled to the real count from the gateway.

**`/usage`** shows the number of turns, tokens in/out, estimated cost, and the **cache**: the percentage read from cache and why the cache missed (first request, the model does not report cache, model switch, idle more than 5 minutes, just compacted, or the system prompt changed). With `+statusline` (experimental, off by default), the status line at the bottom of the terminal shows for example `ctx 12% · $0.0001 · cache 0%`.
