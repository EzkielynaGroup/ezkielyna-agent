# Permissions, sandbox and hooks

This page explains how Ezkielyna Agent asks before it changes files or runs commands, and how you control that. The automatic permission modes, the "always allow" rules, hooks and the sandbox on this page are **(experimental, off by default)**. The beta still asks first.

The mark **(coming soon)** means it is not in this version yet.

> **Note for this version.** Everything on this page exists in the code, but it is switched on with `EZK_FEATURES` and is **experimental and off by default**. We acted on an independent security review (a saved "Edit" rule no longer bypasses protected folders; project settings files are now protected), but we do not recommend these features yet for folders with important data. To try them:
> ```
> EZK_FEATURES="+modes,+rules,+hooks"
> ```
> (or the `ezk` key in `ezkielyna.json`). The sandbox and other features have their own switches, named in their sections. Without a switch the app behaves as before: it asks first.

## The five permission modes (experimental, off by default)

This whole section applies only when `+modes` is on. By default this version uses Ask first.

The mode names are shown in Indonesian in the app (*Tanya dulu*, *Edit otomatis*, *Rencana*, *Otomatis-aman*, *Penuh*). In English they are Ask first, Auto edit, Plan, Safe auto and Full.

| Mode | In short |
|---|---|
| **Tanya dulu** (Ask first) | Asks before every change, command or web access. |
| **Edit otomatis** (Auto edit) | Edits files inside the project by itself. Commands, the web and anything outside the project still ask. **This is the default only when** `+modes` is on. |
| **Rencana** (Plan) | Read-only. Makes a plan, changes nothing. |
| **Otomatis-aman** (Safe auto) | Like Auto edit, plus the commands you chose to "always allow". (The automatic checker for other commands, `+safety.classifier`, is experimental and off by default: a fast model sees only your messages and its tool calls, and protected folders, deny rules and untrusted folders always win. When unsure or on failure it asks; 3 blocks in a row or 20 in total drop the session back to Tanya dulu.) |
| **Penuh** (Full) | Does everything without asking. Use it only in a folder you fully trust. |

### How to switch

- Only when `+modes` is on (except `--permission-mode`, which turns it on for that process).
- **Terminal:** press **Shift+Tab**. The order is Tanya dulu → Edit otomatis → Rencana → Otomatis-aman. **Penuh** is not in the cycle; you have to choose it yourself.
- **Desktop app:** use the selector in the message box.
- **At start-up:** `ezkielyna --permission-mode edit-otomatis` (also for `ezkielyna run`). Accepted names: `tanya-dulu`, `edit-otomatis`, `rencana`, `otomatis-aman`, `penuh`, or `ask`, `acceptEdits`, `plan`, `safeAuto`, `full`. Using `--permission-mode` turns the (experimental) modes feature on for that process.
- **Saved in settings:** `"permission": { "mode": "acceptEdits" }` in `ezkielyna.json`.

Priority: command-line option, then settings, then the default. A choice made in one session only applies to that session.

### What each mode allows (trusted folder)

This table applies only when `+modes` is on.

| | Tanya dulu | Edit otomatis | Rencana | Otomatis-aman | Penuh |
|---|---|---|---|---|---|
| Read and search files | yes | yes | yes | yes | yes |
| Edit a file inside the project | asks | **yes** | **no** | **yes** | yes |
| Edit a protected folder (see below) | asks | asks | no | asks | yes |
| Edit a file outside the project | asks | asks | no | asks | yes |
| Built-in read-only commands (`ls`, `pwd`, `git status`, `git diff`, `git log`, `rg`, `cat`/`head`/`tail` inside the project) | yes | yes | yes | yes | yes |
| A command matching an "always allow" rule | yes | yes | **no** | **yes** | yes |
| Any other command | asks | asks | **no** | asks | yes |
| Open a web page | asks | asks | asks | asks | yes |
| A "deny" rule you wrote | always refuses | always refuses | always refuses | always refuses | always refuses |

Notes:
- In **Rencana** the tools that change files are hidden from the assistant. Commands outside the read-only list are refused, even if you approve.
- **Penuh** shows a warning. "Deny" and "ask" rules you wrote yourself still apply.
- "Always allow" rules and the extended read-only commands (`ls`, `rg`, `git status` and so on) need `+rules` (experimental, off by default).
- When the mode changes, the assistant is told through a small note in your message, not in the system prompt.

## "Always allow" rules (experimental, off by default)

When the app asks, you can choose **Allow once**, **Allow always (this session)**, **Selalu izinkan di proyek ini** (always allow in this project) or **Reject**.

The project option saves a rule such as `Bash(bun test *)` in `.ezkielyna/settings.local.json` (a personal file, mode 0600, added to `.gitignore` for you). Rules use a command prefix:

- `bun test *` allows `bun test`, `bun test src/a.test.ts` and so on.
- Chained commands are checked piece by piece. `bun test; rm -rf ~` does **not** match `bun test *`, because `rm -rf ~` has no rule.
- Commands with variables, substitutions (`$(...)`), heredocs or redirects into files are never allowed by a rule.
- "Always allow edits in this project" is saved as `Edit(**)` and **never** opens a protected folder (see below): those still ask.
- Prefix-based **deny** rules are best effort: a command disguised very cleverly (nested quotes, compound keywords) can slip past the matching. Do not make them your only safeguard.

**Never saved for the whole project** (you can only allow them once): `rm`, `rmdir`, `sudo`, `su`, `dd`, `mkfs`, `chmod`, `chown`, `curl`, `wget`, shells (`sh`, `bash`, `zsh`, ...), interpreters (`python`, `node`, `bun`, `deno`, `perl`, `ruby`, `php`), `eval`, `exec`, `xargs`, `find`, `env`, `ssh`, `scp`, `rsync`, `kill`, `pkill`, `shutdown`, `reboot`, `npx`, `bunx`, and `git push`, `git reset`, `git clean`, `npm publish`, `bun publish`.

You can also write rules yourself in `settings.json` (`permissions.allow`, `permissions.ask`, `permissions.deny`), in the same format as `.claude/settings.json`. The order is deny, then ask, then allow; the first match wins. Type `/permissions` in the terminal to see the mode, the saved rules (local ones can be removed) and the **Recently denied** list.

## Protected folders (on)

The file tools (edit, write, patch) and the shell tool **always ask** for these places, even inside the project, in every mode (Penuh too, and even with an "always allow" rule): `.git`, `.ezkielyna`, `.claude`, `.codex`, `.agents`, `.opencode`, `.aws`, `.ssh`, `.gnupg`, `.husky`, `.vscode`, `.idea`, `.mcp.json`, `.npmrc`, `ezkielyna.json(c)`, `opencode.json(c)`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows`, `.env` and `.env.*` files (except `.env.example`). Upper and lower case are not told apart, and paths through symlinks are checked too. The reason: changing these places can become code execution or a changed instruction without a further question (git hooks, hook settings, commands in config files, CI workflows).

Other protection that is on by default: `git` commands that change the repo always ask, and secret-looking variables (names containing KEY, TOKEN, SECRET, PASSWORD) are removed from the **inherited** environment of child processes (the shell and MCP servers). Variables you set yourself (for example an MCP server's `environment` block) are passed as written. You can allow exceptions for inherited ones with `EZK_ENV_PASSTHROUGH=NAME1,NAME2`.

## Untrusted folders

A project folder can bring its own instructions, hooks and rules. Until you trust it:

- Every mode **except Rencana** is forced to **Tanya dulu**.
- "Allow" rules from the project are ignored. "Deny" and "ask" rules still apply (they only tighten).
- Project hooks, project instructions and project skills are not read.
- The extended read-only command list does not apply.

Trust a folder by running `ezkielyna trust` inside it. In the desktop app, an untrusted folder shows a banner with **Percayai folder ini** (trust this folder) or **Biarkan tidak dipercaya** (leave untrusted). The list of trusted folders is in Settings → General, with a **Hapus** (remove) button.

## Sandbox (Mac and Linux) (experimental, off by default)

In this version the sandbox is **not active**: it follows the permission modes, which are off too. `+sandbox` turns it on in every mode except Penuh.

The sandbox confines **shell commands** at the operating-system level. It differs from permissions: permissions ask first, the sandbox limits what the command can do once it runs.

Allowed inside the sandbox:
- writing in the project folder, the temp folder and the app's output/log/scratch folders (not the whole data folder, so the session database is not included);
- reading most of the system.

**Blocked:**
- writing anywhere else (your home folder, `~/.ssh`, `/etc` and so on);
- writing to `.git`, `.ezkielyna`, `.claude`, `.codex`, `.agents`, `.opencode`, `.ssh`, `.aws`, `.gnupg`, `.husky`, `.mcp.json`, `ezkielyna.json(c)` and `opencode.json(c)`, even inside the project;
- **network** access (for example `curl`, `npm install`; on Linux, Unix sockets that already exist, such as Docker's, can still be reached).

A command that needs one of these fails with a message such as "Read-only file system" or "Operation not permitted", and the app adds a plain-words note. The assistant can then ask, and **you decide**:

- **Network, just this once** (`with_network`): the same command runs again with the network on.
- **Outside the sandbox, just this once** (`require_escalated`): the command runs without confinement.

Both appear as an approval card with the command and a one-line reason from the assistant. Choose once. "Always" is only offered for prefixes that are safe to remember (not for `bash`, `python`, `curl` and the like).

Example: the assistant runs `npm install`, it fails because the network is blocked, and the assistant asks for the network with the reason "installing dependencies". You approve once; the next command goes back into the sandbox.

**How to turn it on:** `EZK_FEATURES=+sandbox` (active in every mode except Penuh), or start with `--permission-mode edit-otomatis` / `otomatis-aman`, which use the sandbox. Turn it off with `-sandbox`. Penuh never uses the sandbox. When `+modes` is on, the sandbox follows the session's mode (Shift+Tab, the desktop selector, `--permission-mode`). Background commands (`+exec`) run in the sandbox too.

**Linux:** needs `bubblewrap` (for example `sudo apt install bubblewrap`). Without it, commands run as before with ask-first, and you see one tip. Limitation: a command can still **create** a new folder or file named `.git`, `.claude` or `.ezkielyna/settings.json` in the project (existing ones stay read-only). On Mac that is blocked.

**Windows:** there is no sandbox. Commands run as usual with your approval. The same applies to PowerShell and cmd on other systems.

Limit on every system: the sandbox does **not forbid reading** (a command can still read `~/.ssh`), but with the network off it cannot send it anywhere. The overhead is about 4 to 5 milliseconds per command (measured on Linux).

## Hooks (experimental, off by default)

A hook is a small program of yours that runs at a set moment: before a tool is used, after it, when the assistant is about to stop, and so on. With hooks you can block something or add a check.

**Turn on:** `EZK_FEATURES=+hooks`. Hooks run programs on your computer, so they are not active on their own.

**Only in trusted folders.** Hooks from a project (`.ezkielyna/settings.json`, `.claude/settings.json` and their `.local` versions) are read only when the folder is trusted. Your own hooks in `~/.config/ezkielyna/settings.json` or `~/.claude/settings.json` always apply.

**Compatible with `.claude/settings.json`:** the `hooks` section uses the same format (event names, `matcher`, `type`, `command`). Hooks you already wrote there work as they are.

Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`.

How a command hook works: it receives JSON on stdin. **Exit code 2 = block**, and what it writes to stderr goes to the assistant as the reason. Exit 0 = continue. Any other code = does not block, only shown. Time limit: 60 seconds.

### Example 1: forbid editing `.env`

Create `.ezkielyna/hooks/guard-env.sh`:
```sh
#!/bin/sh
# Receives JSON about the tool call on stdin.
if grep -q '\.env' ; then
  echo "Do not change .env files. Ask the user to do it." >&2
  exit 2
fi
exit 0
```
Then in `.ezkielyna/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "sh .ezkielyna/hooks/guard-env.sh" }]
      }
    ]
  }
}
```
Result: whenever the assistant tries to edit or write a file and the JSON mentions `.env`, the step is blocked and the assistant reads the reason. (This example is deliberately blunt: it also blocks any file whose name merely contains ".env".)

### Example 2: run the tests before finishing

`.ezkielyna/hooks/test-first.sh`:
```sh
#!/bin/sh
if ! out=$(bun test 2>&1); then
  echo "Tests still fail. Fix them first:" >&2
  echo "$out" | tail -n 30 >&2
  exit 2
fi
exit 0
```
`.ezkielyna/settings.json`:
```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "sh .ezkielyna/hooks/test-first.sh", "timeout": 120 }] }
    ]
  }
}
```
If the tests fail, the assistant may not stop and is asked to fix them. To avoid looping forever, after **8** blocks in a row the `Stop` hook is ignored. A hook is cut off after 60 seconds at most, even if you write a larger number, so use a fast test.

Other things to know:
- A `PreToolUse` hook that answers "allow" skips the normal permission question, but it **never** overrides a deny rule, Rencana mode, an untrusted folder or a protected folder.
- A hook can also use `type: "http"` (sends the JSON to an address you write).
- When a session starts, the app shows the list of active hooks. The list shows again only when the hooks change. In an untrusted folder, the app tells you that project hooks were skipped.
- The agent's own secret environment variables are removed from hook processes.
