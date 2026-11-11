# Bench v2

30 real coding tasks that tell us whether a change to the agent (a harness item, a router rule, a model) makes it
better or worse at actual work (DESIGN-V3 §3 L8, Q1/Q2). Each task is a tiny repo plus a prompt, graded by a command
or by required keywords, never by a model.

```
bun bench/check-tasks.ts                 # validate the tasks (no agent, no model), ~15 s
bun bench/selfcheck.ts                   # every task fails untouched and passes with solution.patch
bun bench/run.ts --dry-run               # whole harness through the real CLI, mock gateway, no key
EZK_BENCH_KEY=... bun bench/run.ts --gateway https://gateway.example --model ezk-auto --max-budget 1 --parallel 1
bun bench/ab.ts --a 'EZK_FEATURES=-router' --b 'EZK_FEATURES=+router' --tasks bugfix- --repeats 2 --dry-run
bun bench/run.ts --agent upstream --model deepseek-v4.1-flash ...   # upstream OpenCode on the same tasks, see below
cd bench && bun test                     # unit tests of the runner itself
```

Requirements on the machine that runs it: Bun, `bash`, `git`, `python3` (standard library only) and Go ≥ 1.22.
Nothing needs the network except the agent's own calls to the gateway in a real run.

## The tasks

| Category | Count | What is checked |
|---|---|---|
| `bugfix` | 8 | a failing test in the repo must pass, plus hidden extra cases |
| `refactor` | 6 | behaviour unchanged (tests) plus a hidden structure check (old name gone, code moved, file deleted, …) |
| `feature` | 6 | hidden tests for the new behaviour, and the agent must add its own test that mentions the new symbol |
| `qa` | 4 | "explain the repo" / code questions: the final answer must contain required keywords |
| `data` | 3 | CSV/Excel in, a CSV out; a hidden Python check recomputes the expected rows from a pristine copy |
| `awam` | 3 | Indonesian requests from non-programmers (tidy a folder, a guest list, a weekly spending total) |

Languages: TypeScript (`bun test`), Python (`unittest`), Go (`go test`); prompts in Indonesian, English and mixed.
Each repo is under 50 files.

### Task layout

```
bench/tasks/<id>/
  task.json     id, category, lang (id|en|mix), title, prompt, verify and/or keywords, timeout_sec (default 600)
  repo/         the starting workspace the agent sees
  hidden/       files copied over the workspace AFTER the agent finishes, before verify (the agent cannot weaken them)
  solution.sh   reference solution, run from the workspace root (never shown to the agent in real runs)
  solution.md   reference answer (Q&A tasks, and tasks that also check the answer)
```

### Scoring

A task **passes** when both hold:
- `verify` (if present) exits 0. It runs with `bash -c` in the workspace after `hidden/` has been copied in.
- every group in `keywords` (if present) matches the agent's final answer, case-insensitively. A group is a list of
  alternatives: `[["milidetik", "millisecond", "ms"], ["session.ts"]]` needs one of the first three **and** `session.ts`.

There is no partial credit. Timeouts, crashes and agent errors fail the task; the reason is recorded.

## Adding a task

1. Create `bench/tasks/<category>-NN-<short-name>/` with the layout above. Keep the repo tiny and offline: standard
   library only, no package installs during verify.
2. Make the starting state fail for the right reason (a failing test, a missing function, a missing output file).
3. Put the strict tests in `hidden/` (same paths as in the repo, so they overwrite the agent's copy). For a feature,
   append `&& grep -rl --include='*.test.ts' -e '<symbol>' src | grep -v bench_hidden | grep -q .` to `verify` to
   require the agent's own test; name hidden test files `bench_hidden*` so that check ignores them.
4. Write `solution.sh` (idempotent: the dry run may replay it) and, for Q&A, `solution.md`.
5. Run `bun bench/check-tasks.ts --tasks <id>`: the untouched repo must FAIL and the reference solution must PASS.
6. Update the count in `bench/test/tasks.test.ts` if you change the mix.

## run.ts

Per task: copy `repo/` into a fresh temp dir (committed to git, so `diff.patch` shows exactly what the agent did),
run the agent there with an isolated HOME, copy `hidden/` in, grade.

The agent is run as `ezkielyna exec --json` when the binary has that command (Codex-compatible events), otherwise
`ezkielyna run --format json`. Always with `--dir <workspace>` and `PWD=<workspace>`: the CLI resolves its project
from `PWD` before the process cwd, so without it the agent would edit the directory bench was started from.

| Option | Meaning |
|---|---|
| `--model <id>` | `provider/model` or a bare Ezkielyna id (`ezk-auto`, `deepseek-v4.1-flash`, …). Dry run default: `ezk-auto` |
| `--tasks <filter>` | ids, id prefixes or `category:<name>`, comma-separated |
| `--features=<list>` | `EZK_FEATURES` for the agent, e.g. `--features=-router,+mcp-defer` (use `=`, the value starts with `-`). `+router.log` is always added so router decisions can be read |
| `--max-budget <usd>` | required for real runs; stop starting tasks once estimated spend reaches this cap |
| `--price <in/cached/out>` | USD per 1M tokens for the cost estimate; default is the router's price table (`packages/core/src/ezk/pricing.ts`) |
| `--parallel <n>` | tasks at the same time (default 1; any finite-budget run requires 1) |
| `--dry-run` | mock gateway + fake key, see below |
| `--baseline <results.jsonl>` | compare with an earlier run in `summary.md` (only tasks present in both) |
| `--bin <path\|source>` | the agent: a binary, or `source` (= `bun packages/opencode/src/index.ts`). Default: `ezkielyna` on PATH, else source (`opencode` on PATH with `--agent upstream`) |
| `--mode exec\|run` | force the agent command instead of detecting it |
| `--agent ezkielyna\|upstream` | which agent runs the tasks; see "Upstream arm" |
| `--timeout <s>`, `--out <dir>`, `--keep` | per-task limit override, results dir (default `bench/results/<time>-<model>`, git-ignored), keep workspaces |

### What is recorded (results.jsonl, one line per task)

| Field | Source |
|---|---|
| `pass`, `reason`, `missing_keywords` | verify exit code and keyword groups |
| `turns` | model calls (`step_finish` events). With `exec --json` it is approximated as tool items + agent messages, because Codex events do not mark model calls |
| `duration_ms`, `verify_ms` | wall time of the agent and of the verify command |
| `tool_calls`, `tool_errors`, `tool_error_details` | `tool_use` parts with status `error` (exec: items with status `failed`/`declined`) |
| `edit_failures` | the tool errors from `edit`, `write`, `apply_patch`, `multiedit`, `patch` (exec: failed `file_change`) |
| `tokens` | input (uncached), cached input, output, reasoning, cache write; summed over steps |
| `cost` | as reported in the events. Ezkielyna models report 0 there (no client-side prices) |
| `cost_estimated`, `price_source` | tokens × `--price`, or × the price table for the model that ran (the router's last decision under `ezk-auto`) |
| `cache_hit_ratio` | cached input / (input + cached input) |
| `router` | decisions, fallbacks, escalations, per-model and per-tier counts from `<data>/ezk/router.log.jsonl` |
| `agent`, `agent_version` | `ezkielyna` or `upstream`, and what `<bin> --version` printed |

The budget and the totals use the larger of `cost` and `cost_estimated`. `summary.md` has the totals, a per-category
table, a per-task table, the failures with reasons and, with `--baseline`, the deltas and the tasks that flipped.
`logs/<task>/` keeps `events.jsonl`, `stderr.txt`, `answer.md`, `diff.patch`, `verify.txt` and `router.log.jsonl`.

## Dry run

`--dry-run` starts the shared mock gateway (`packages/core/test/ezk/mock-gateway.ts`, the one the router/memory e2e
tests use) per task and points the agent at it (`EZKIELYNA_BASE_URL`, fake `EZKIELYNA_API_KEY`). The mock plays a
scripted agent: one shell tool call that runs the task's reference solution (copied into the workspace as
`.bench/solution.sh`, git-excluded), then a final message with `solution.md`. So every task must pass; a failure means
the harness, the CLI or a task broke, and the run exits 1. It exercises the real CLI end to end: model listing,
`ezk-auto` routing (router log), the tool loop, events, token/cache accounting (the mock reports cached tokens) and
the cost estimate. It never contacts the real gateway and never needs a key.

The manual workflow **bench-dry-run** (Actions tab → Run workflow; `workflow_dispatch` only) runs the unit tests,
`check-tasks.ts` and the dry run on Linux and uploads `bench-results/`.

## Real runs (coordinator, VPS)

Real runs use the live gateway and cost money; they are not run in CI. The key is read from `--key-env` (default
`EZK_BENCH_KEY`) and passed only to the agent process as `EZKIELYNA_API_KEY`; it is never printed or written to logs.
Live runs require `--parallel 1`, so the budget check completes before the next task is scheduled. On the VPS:

```
export EZK_BENCH_KEY=...              # from the VPS secret store; never commit or print it
export EZK_BENCH_GATEWAY=https://gateway.example
bun bench/docker/run-vps.sh
```

DESIGN-V3 Q1 asks for a ≤ $1 token cap per nightly run (§7, open decision 5: about $1 per run, or weekly runs only);
`--max-budget 1` stops scheduling against the larger of reported and estimated cost after each task. A v3 item is default-on
only if Bench v2 does not regress: run it with the item's flag on and off and compare with `--baseline` or `bench/ab.ts`.

## Selfcheck and reference patches

`bun bench/selfcheck.ts` checks all tasks without a model. It verifies that the pristine workspace fails, runs the
reference `solution.sh`, saves its git diff as `tasks/<id>/solution.patch`, applies that patch to a fresh workspace,
copies hidden tests, and verifies that the solved workspace passes. Use `--tasks <filter>` for one task or category.

## A/B runs

`bench/ab.ts` alternates A and B for the same tasks and repeats, switching order between pairs. It writes `AB.md`
with pass rates, average turns/cost/time, B−A deltas, and an exact paired sign test on pass/fail. Fewer than ten
non-tied pairs are marked as too small. Real A/B runs require `--max-budget` and share that cap across both arms.

## Upstream arm

`--agent upstream` runs the same tasks with upstream OpenCode v1.19.3 (the version this fork is based on) through the
same gateway and model, so a run can say "Ezkielyna vs upstream, same model". Upstream has no `exec` command and no
router, so the agent is always `opencode run --format json` and `--model` must name a concrete gateway model. Per task
the runner writes an `opencode.json` into the isolated HOME (`OPENCODE_CONFIG`; a copy is kept in
`logs/<task>/opencode.json`): an `@ai-sdk/openai-compatible` provider `ezk-bench` whose `baseURL` is `--gateway`
verbatim (the same string the Ezkielyna arm gets as `EZKIELYNA_BASE_URL`, whose default ends in `/v1`), the model, every
permission allowed, and the key as the template `{env:EZK_BENCH_UPSTREAM_KEY}`; the key value itself is only in that
variable of the agent's environment, never in a file. The agent env is `OPENCODE_DISABLE_AUTOUPDATE`,
`OPENCODE_DISABLE_MODELS_FETCH` (the container may only reach the gateway), `OPENCODE_DISABLE_LSP_DOWNLOAD`,
`OPENCODE_DISABLE_PROJECT_CONFIG`; no `EZK_*` variables and no router log. Upstream has no telemetry switch: its
OpenTelemetry export is opt-in through `experimental.openTelemetry`, which the generated config does not set.
`results.jsonl` rows and `summary.md` record `agent: upstream` and `opencode --version`.

```
# dry run on this machine: no upstream binary needed, the stub plays upstream against the mock gateway
bun bench/run.ts --dry-run --agent upstream --bin bench/test/fixtures/upstream-stub.ts --model deepseek-v4.1-flash --tasks qa-01
# real run on the VPS (costs money: the whole suite is capped at $1 by run-vps.sh, same as the Ezkielyna arm)
export EZK_BENCH_KEY=... EZK_BENCH_GATEWAY=https://gateway.example/v1
BENCH_AGENT=upstream BENCH_MODEL=deepseek-v4.1-flash bash bench/docker/run-vps.sh
# paired comparison, both arms on one model
BENCH_MODE=ab BENCH_A='agent=ezkielyna' BENCH_B='agent=upstream' BENCH_MODEL=deepseek-v4.1-flash bash bench/docker/run-vps.sh
```

Locally, `bun bench/ab.ts --a 'agent=ezkielyna' --b 'agent=upstream' --model <id> ...` does the same (`--upstream-bin`
names the opencode binary; an arm may also pin `model=<id>`). The Docker image installs upstream from the archive its
own installer uses (`github.com/anomalyco/opencode` release `v1.19.3`, `opencode-linux-x64.tar.gz`); pass
`--build-arg OPENCODE_UPSTREAM_SHA256=<sha256>` once known, since the release publishes no checksum.

## VPS container

`bench/docker/run-vps.sh` builds the constrained image and starts a container with 2 CPUs and 4 GB RAM. The
container blocks outbound traffic by default and allows HTTPS only to the configured gateway IP, runs as an
unprivileged user, and keeps task inputs read-only. It installs the CLI through the HTTPS distribution installer and
upstream OpenCode v1.19.3 as `/usr/local/bin/opencode`.
Set `BENCH_MODE=ab`, `BENCH_A`, `BENCH_B`, and optionally `BENCH_TASKS` / `BENCH_REPEATS` to run A/B in the same
container and network restrictions; `BENCH_AGENT=upstream` with `BENCH_MODEL` runs the upstream arm alone.

Not covered yet: Q3 (router calibration from outcomes) can be fed from `results.jsonl` (`router.tiers` vs `pass`), but
no calibration job is included here.
