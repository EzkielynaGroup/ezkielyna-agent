# Privacy

There is no telemetry. The app only contacts the Ezkielyna gateway (`api.ezkielyna.store`), and the download site to check for updates.

## Stays on your computer
- **Memory**: `~/.config/ezkielyna/memory/` (`MEMORY.md`, `USER.md`).
- **History search**: the index `~/.local/share/ezkielyna/ezk/search.db`.
- **Sessions and conversations**: the local database under `~/.local/share/ezkielyna/`.
- **Router decision record**: `route-turns.jsonl` (only which model was chosen, no message text). The more detailed decision log is off by default and is never uploaded.
- Your API key.

These files are readable only by your computer account (mode 0600).

## Sent to the gateway
- Your messages, the file contents or command output the model asked for, and the system prompt. The model needs these to answer.
- Memory notes are sent **as part of the prompt** to the gateway you use, nowhere else.
- One background call: the memory reviewer uses a Flash model (at most 40 times a day; turn it off with `EZK_FEATURES=-memory`).
- The model list and prices are read from the gateway/site (public).

Do not paste passwords or keys into the chat. The memory scanner refuses to save them, but what you type is still sent to the model.

## Deleting everything
- Memory and search index: `ezkielyna memory wipe` (add `--all` for router data, `--yes` to skip the confirmation), or the **Erase memory** button in the desktop app.
- Conversation history: delete sessions from the session list, or delete the folder `~/.local/share/ezkielyna/`.
- All settings and keys: delete `~/.config/ezkielyna/` and log out of the provider.
- CLI: delete `~/.ezkielyna`. Desktop: move the app to the Trash / normal uninstall.
