# Features

**(coming soon)** means the feature is not in this version, or we have not confirmed it works yet. **(experimental, off by default)** means the feature is in the code but you have to switch it on yourself, and we do not recommend it yet for folders with important data.

## Auto (Pintar): automatic model choice

In the model list, choose **Auto (Pintar)**. For each message the app rates how hard the task is and picks a model from the ones your key may use:

- **light** tasks (a question, a rename, a short translation) → a fast, cheap Flash model
- **heavy** tasks (refactoring many files, hard bugs, building an app) → a stronger model, if your key has one

The rating runs on your computer and does not call a model. When unsure, the app leans towards "heavy".

Force it for one message with a prefix at the start of the message:
```
@heavy find out why the checkout test sometimes fails
@light rename the variable tmp to buffer
```
If a model fails (for example 403 or a timeout), the app switches once to the next healthy model and shows the reason in a small label next to the model name. A failed model is "cooled down" for 2 to 30 minutes.

Turn the router off with the environment variable `EZK_FEATURES=-router`.

## Pinning a model

Choose a specific model in the model list (not Auto). It is used every time and never rerouted. In the CLI: `/pin`. See the last decision with `/route`, go back to automatic with `/auto`.

## Cost cap

The router has a per-session cost cap, **$1** by default. Over the cap, the next turn is moved to the cheapest Flash model and the label says "cost cap". Change it in `~/.config/ezkielyna/ezkielyna.json`:
```json
{ "ezk": { "router": { "capUSD": 2 } } }
```
`0` means no cap. The cost is an estimate from the public price list.

## Memory

The app can remember small facts about you and your projects (files `MEMORY.md` and `USER.md`, very short), such as "I prefer Indonesian". They are stored only on your computer. You can see and remove notes in the **Memory** dialog (desktop) or `/memory` (CLI). Passwords, keys and card numbers are never saved.

- **Erase everything**: the **Erase memory** button (desktop), or `ezkielyna memory wipe`.
- **Private session**: turn on **Private session** (desktop) or `/private`. In that session memory is not read or written and the session is left out of search.
- Turn it off completely: `EZK_FEATURES=-memory`.

## Searching history

Search old conversations from the **Search sessions** dialog (desktop) or `/search keyword` (CLI). The search is local; nothing is sent out. Private sessions do not appear.

## Free web search

With an Ezkielyna key, the assistant can search the web with the `web_search` tool. It is free for every key holder.

- Only the search query is sent, to our own server. No files or folder contents leave your machine.
- Results are a short list (title, URL, snippet). To read a page, the assistant uses `webfetch`.
- **Limits:** 30 searches per minute and 500 per day for each key. When the limit is reached, the assistant stops searching and continues with what it already has. A search returns at most 10 results, the query is 1-400 characters, and it times out after 15 seconds.
- **Permissions:** in **Ask first** mode (the default), the app asks on the first search in a session, and you can choose **always allow web_search**. When the permission modes are switched on (experimental), searching runs without asking in **Auto edit** and **Safe auto** (in a trusted folder).
- Without a key the tool is not offered. Turn it off with `EZK_FEATURES=-websearch`.

## Skills

The assistant lists your skills (name and a one-line description) and loads a skill's full text only when it uses it. The list is capped at about 8,000 characters. Skills in `.claude/skills` and `.agents/skills` are read only in folders you trust (`ezkielyna trust`). Skills the assistant proposes after a task still wait in the approval queue (`/skills`). The helper that proposes them now uses the cheapest fast model your key allows, so keys with only fast models work too.

## Instructions: AGENTS.md and CLAUDE.md (experimental, off by default)

Turn on `+context.hierarchy` (in `EZK_FEATURES` or the `ezk` key of `ezkielyna.json`) and the assistant reads your instructions in this order: your own file (`~/.config/ezkielyna/AGENTS.md`), then every folder from the project root down to where you are, then personal `*.local.md` files. Both `AGENTS.md` and `CLAUDE.md` are read; `AGENTS.override.md` replaces them in its folder.
- `@path/to/file.md` pulls another file in (up to 4 levels). Only `.md`, `.mdc` or `.txt` files inside the project; secret or protected files (`.env`, `.git/...`, keys, project settings) are never pulled in, and the total size of what is pulled in is capped.
- `rules/*.md` files with `paths: ["src/**/*.ts"]` at the top apply only when the assistant touches a matching file.
- `<!-- comments -->` are removed. The total is capped at 32 KiB, and a note tells you if text was cut.
- In a folder you have not trusted (`ezkielyna trust`), project files are skipped. Your own file still applies.

## Session start and bug fixes (experimental, off by default)

`+context.session` adds a short note to the first message: a small folder tree, your tool versions (node, bun, python, go, cargo) and the command that checks the project (tests, types, lint). In a folder you have not trusted, the project's package-manager version check is skipped. `+context.reproduce` adds a three-step reminder when your message asks for a bug fix: reproduce it first, find the exact lines, change as little as possible.

## `/review`

`/review` and `ezkielyna review` are always there. The P0 to P3 rubric on the fast model is always used by `ezkielyna review` (terminal), and by `/review` only when `+review` is on (experimental, off by default).

Type `/review` (desktop or terminal) or run `ezkielyna review` to get a code review of your uncommitted changes. Other targets: `ezkielyna review --base main`, `ezkielyna review --commit abc123`, or add your own instructions (`ezkielyna review "check the login code"`). You get at most 10 findings marked P0 (worst) to P3, each with `file:line`. Only about 600 lines of diff are read. It runs on a cheap fast model. `/review` uses this format when `+review` is on.

## Telegram bridge (experimental, off by default)

You can instruct Ezkielyna from your phone through a Telegram bot that **you own**. It stays off until you set it up with `ezkielyna gateway telegram`:
1. Create a bot with @BotFather in Telegram and copy the bot token.
2. Store the token on your computer (with a command, not in a chat), then add your Telegram ID to the **allowlist**. Anyone not on the list is refused.
3. Private chats only. Permission questions appear as buttons in the chat.

## Code search and repo map (experimental, off by default)

Two helpers for big projects. **Both are off by default.**

- **`code_search`** (`EZK_FEATURES=+codesearch`): the assistant looks up functions, classes and files by name or by words in comments, without reading the whole project. The index is small, stays on your computer, is built on the first search (up to tens of seconds on a big project; later searches take milliseconds) and is refreshed only for files that changed. Nothing is sent out. It understands TypeScript, JavaScript, Python, Go, Rust and Java.
- **Repo map** (`+repomap`): a summary of about 1,000 tokens listing the most important files and functions, added once per session on heavy tasks in a git repo with more than 200 files. Our tests on big repos were not convincing, so keep it off for now.

Memory use: building the first index temporarily adds about 100 to 300 MB, depending on project size.

## Permissions, sandbox and hooks

The five permission modes (Tanya dulu, Edit otomatis, Rencana, Otomatis-aman, Penuh), "always allow" rules, the sandbox and hooks (all experimental, off by default), and protected folders (on) are explained in [izin.md](izin.md).

## Rewind, plans, background work and automation

`/rewind`, plan approval, `/handoff`, the Explore subagent and background tasks (experimental, off by default), plus `ezkielyna exec --json` for CI, `ezkielyna doctor`, `/context` and `/usage` (on), are explained in [alur-kerja.md](alur-kerja.md).

## Compacting the conversation (experimental, off by default)

With `EZK_FEATURES=+compaction`, a long conversation is compacted at about 90% of the model's context window: old tool results are dropped first, then a fast model writes a hand-off summary; about 20,000 tokens of your most recent messages, the project instructions, memory, the approved plan and the last 5 files are put back. After 3 failures in a row it stops trying. Type `/compact <focus>` to steer the summary (for example `/compact design decisions`).

## Trusted folders (`ezkielyna trust`)

A project folder you open can bring its own plugins, instructions, hooks or permission rules. For safety they are all ignored until you run this inside that folder:
```
ezkielyna trust
```
When the permission modes are switched on (experimental, off by default), in an untrusted folder every mode except Rencana is forced to Tanya dulu. The desktop app also has a banner to trust a folder and a list of trusted folders in Settings. Details in [izin.md](izin.md).

## "Ask before acting" permissions

Before editing a file or running a command that is not yet allowed, the app stops and asks. The choices are: **once**, **always** (for that pattern) or **reject**. Choose "always" only for commands you understand. The other modes, the rules, and what can never be saved as "always" (experimental) are in [izin.md](izin.md).
