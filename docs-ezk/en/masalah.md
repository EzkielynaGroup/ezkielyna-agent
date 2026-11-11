# Troubleshooting

## Invalid key (401)
- Copy the whole key again from https://api.ezkielyna.store/keys. Make sure there are no spaces at the start or end and it begins with `sk-`.
- If the key was deleted or disabled, create a new one and log in again (`ezkielyna providers login`).

## Balance or quota used up (402 / 403)
- Check your balance or remaining quota in your account at https://ezkielyna.store, then top up or wait for the quota to renew.
- In **Auto (Pintar)** mode the app tries another model first. If all are refused you still get an error.

## Too many requests (429)
Wait a moment and retry. Do not run many sessions at once with one key. In Auto mode the app switches to another model by itself.

## Model unavailable / "no available channel" (404, 503)
That model is switched off or is not part of your key. Pick another model, or use **Auto (Pintar)**. Check https://ezkielyna.store/status.

## No answer appears
If a model does not start answering within 25 seconds, Auto (Pintar) moves to the next model. If you pinned one model, try another.

## The app will not open
- **macOS**: right-click the app → **Open** → **Open**. If still blocked: `xattr -dr com.apple.quarantine "/Applications/Ezkielyna Agent.app"`.
- **Windows**: **More info** → **Run anyway**. If antivirus removes the file, download again and allow it.
- **Linux AppImage**: make sure you ran `chmod +x`.
- Still failing: install the CLI (see [mulai.md](mulai.md)); the CLI does not need the app window.

## `ezkielyna: command not found`
Open a new terminal. If it still fails, add this to your shell profile: `export PATH="$HOME/.ezkielyna/bin:$PATH"`.

## The sandbox blocked something (only when the sandbox is switched on: experimental, off by default)
Symptom: a command fails with "Read-only file system", "Operation not permitted" or a network error (for example `npm install` cannot download), and there is a note that the command "ran in the sandbox and was probably blocked".
- That is normal: the sandbox only allows writing in the project folder and the temp folder, and allows no network. Folders such as `.git`, `.claude`, `.ssh`, `.aws` are always read-only.
- Let the assistant ask. It shows an approval card for **network just this once** or **outside the sandbox just this once**, with its reason. Approve only if you understand the command.
- To turn the sandbox off: `EZK_FEATURES=-sandbox`. On Linux, a tip saying "install bubblewrap" means the sandbox is not active because `bubblewrap` is missing. Windows has no sandbox.
- See [izin.md](izin.md).

## A hook blocked a step (only when `+hooks` is switched on: experimental, off by default)
Symptom: the assistant says a step was blocked and quotes a reason, or refuses to stop because "tests still fail".
- The reason is the text your hook wrote to stderr (exiting with code 2). Read the hook script named in the `hooks` section of `.ezkielyna/settings.json`, `.claude/settings.json` or `~/.config/ezkielyna/settings.json`.
- A `Stop` hook that keeps blocking is ignored automatically after 8 times in a row.
- Project hooks only run in trusted folders. A hook that "does nothing" is usually because the folder is not trusted (`ezkielyna trust`) or `+hooks` is not on. A hook that runs past 60 seconds is stopped.
- To switch all hooks off for now, remove `+hooks` from `EZK_FEATURES`.
- See [izin.md](izin.md).

## The web search limit was reached
Symptom: the assistant says the search was refused (code 429) and carries on without searching.
- The limits are 30 searches per minute and 500 per day per key. Wait a minute, or until tomorrow if the daily limit is used up.
- A "key not valid" message (401) is different: check your key (see "Invalid key" above).
- You can tell the assistant to use a page you paste, or to `webfetch` one specific address.

## Checking your installation with `ezkielyna doctor`
Run `ezkielyna doctor` and read one line per check: `✓` good, `!` warning, `✗` failed.
- **API key**: should say "found". If not, log in again with `ezkielyna providers login`. The key is never printed.
- **Connection**: if it fails, check your internet, VPN or proxy, then https://ezkielyna.store/status.
- **This folder is not trusted**: project instructions and hooks are ignored. Run `ezkielyna trust` if you wrote that project.
- Low **free disk space**: free some space.
- **Updates** "off": download the new version from ezkielyna.store.
- For support: send the `doctor` output (safe to share, the key is not in it). Still skim it before sending.

## Sending logs to support without exposing your key
1. Send the **version** (`ezkielyna --version`), your operating system and the **error text** shown.
2. If a log is needed, take files from the log folder: `~/.local/share/ezkielyna/log/`. **Open the file in a text editor first and search for "sk-"**; remove anything that looks like a key before sending.
3. Do not send `auth.json`, the contents of `~/.config/ezkielyna/`, or screenshots of the keys page.
4. If a key was sent by accident, delete it at https://api.ezkielyna.store/keys and create a new one.
