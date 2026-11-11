# CHANGES-V1.1 (branch ezk-v2)

## Router "Auto (Pintar)" (track R) - done

* New picker entry **Auto (Pintar)**. Per user message the router classifies the turn (heuristic, microseconds) and picks a model from the key's own `/v1/models` list through `model-policy.ts`:
  light -> Flash, heavy -> `deepseek-v4-pro-0813` when the key has it (default-group keys), Flash-plan keys stay on Flash, gateway alias as the last resort. Claude/GPT chains exist but are deferred and hidden (D5).
* Circuit breaker per model: 401/402/403/404 (and gateway "no available channel") open 30 min, 429/5xx/timeout open 2 min after 2 strikes; success closes.
* Fallback inside the request: a failed call is retried once on the next healthy chain model, no multi-second retry backoff; first byte must arrive within 25 s; the switch is recorded (`fallbackFrom`, reason) and shown by `GET /ezk/router/turns`.
* Sticky: after a switch the session keeps the new model for 10 min (prompt cache stays valid); heavy->light needs a clearly low score.
* Mid-turn escalation (new hook `experimental.model.select`): two failing shell steps in a row move a light turn to the heavy tier, at most twice per message.
* Per-session cost cap (default $1, `ezk.router.capUSD`, 0 = off): over the cap the turn is downgraded to the cheapest Flash model and the reason says so.
* Pin = choose any concrete model (or a gateway alias); `@heavy` / `@light` at the start of a message forces the tier for that message.
* Local-only decision log (off by default, `ezk.router.log`): features only, 1 MB x 3 rotation, mode 0600.
* Kill switch: `EZK_FEATURES=-router`.

Memory, search and UI: see later sections.

## Memory (track M) - done

* `MEMORY.md` (<= 2,200 chars) and `USER.md` (<= 1,375 chars) per profile in `~/.config/ezkielyna/memory/`, entries separated by `§`, mode 0600, atomic writes. On by default with a first-use notice.
* Frozen into the system prompt once per session (the prompt cache stays valid); changes apply from the next session. Empty store = zero bytes. Private session (per session) = no block, no writes, not searchable.
* `memory` tool (add / replace / remove). Every write (tool and reviewer) passes the scanner: API keys, tokens, JWTs, private keys, card numbers (Luhn), credential assignments, seed phrases, long random tokens, plus prompt-injection phrases, exfiltration commands and invisible unicode are refused.
* Post-turn reviewer (flag `ezk.memory.review`): one non-streaming call on a Flash model with a compact digest (<= 6,000 chars) every 6 user turns or right after "remember/ingat ...", at most 40 per day, 60 s apart. Prompt says what NOT to save; ops are capped at 5 and go through the same store.
* `ezkielyna memory status|show|wipe`, Desktop "Erase memory" (two-click), TUI `/memory`.

## Session search (track M) - done

* `session_search` tool and `/ezk/search`: FTS5 (porter + unicode61, BM25) in a separate additive `search.db`, built lazily on first use, incremental afterwards (streamed edits replace the old text), private sessions never indexed or returned.

## UI (track U) - done in code, not seen on screen

* TUI: per-turn route badge (`auto light`, `switched from X (HTTP 403)`, `escalated`, `cost cap`, `pinned`), `/auto`, `/pin`, `/route`, `/memory`, `/private`, `/search`, memory notice toast.
* Desktop: per-turn badge next to the model in the message header, sidebar rows Memory and Search sessions, Memory dialog (notice, Private session, notes with remove/add, last review, Erase memory), Search dialog; EN and ID strings.
