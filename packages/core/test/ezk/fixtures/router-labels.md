# Router calibration v2: labeling rules

Rules are applied from the prompt text alone. Session signals such as files touched, repeated tool failures, and context size are tested separately. `router-prompts.jsonl` contains 250 rows with tier (`light`/`heavy`) and intent (`fix`/`plan-needed`/`qa`/`other`) labels.

## Tier labels

`heavy` means the request benefits from deliberate multi-step reasoning: cross-file or repository scope, architecture/design choices, migration or refactor, uncertain repeated failure, a multi-part feature, or long structured output. The existing v1 rules remain in force: multi-stage data work, bulk translation, and broad cross-file questions are heavy; a focused question or one-file task is light. When uncertain, err toward heavy because a heavy-to-light miss is costlier.

`light` means one bounded operation with a clear scope: a small edit, a focused code/data operation, one command, short writing/translation, a direct question, or chat. A bugfix with a known failing test in one function can be light; an unknown/flaky cause or several affected modules is heavy.

## Bench v2 labels and exceptions

The 30 prompts are copied from `bench/tasks/*/task.json` and labeled individually:

* All 8 bugfix tasks are heavy: each asks to repair behavior against a failing test or a reported data defect.
* All 6 refactors are heavy: they move or rename behavior across files/callers while preserving compatibility.
* Feature 01 (priority API plus stable sorting) and feature 04 (generic TTL cache plus injectable clock) are heavy because they introduce coordinated behavior/API contracts. Features 02, 03, 05, and 06 are light exceptions: each is a narrow formatting, CLI, small-function, or route change with a focused scope.
* Q&A 01 (abuse/security explanation across the repository) and Q&A 03 (CSV-to-report dataflow across files) are heavy. Q&A 02 (one logout symptom, read-only explanation) and Q&A 04 (callers of a named function) are light.
* Data 03 is heavy because it combines normalization, deduplication, date conversion, and choosing the earliest row. Data 01 and 02 are single-file transformations and are light.
* All three layperson tasks are light: each is a bounded folder/list/text operation with explicit output rules.

## Intent labels

Intent is independent from tier; a light/heavy task can have any intent.

* `fix`: asks to repair a current bug, regression, failing behavior, or broken result. A direct “fix typo/format/lint” request without a functional defect is `other`.
* `plan-needed`: explicitly asks for a plan first, or requests coordinated architecture, migration, a repository-wide refactor, rollout, a deep cross-package review, or a multi-file/API change with compatibility and sequencing rules to map.
* `qa`: asks for information, explanation, diagnosis without edits, or a read-only review/report. Questions remain `qa` even when they mention “fix” (for example, “How do I fix this?”). “Do not change the tests” is a test constraint on an edit request, not a read-only request.
* `other`: ordinary feature/edit/content/command requests, follow-ups without a new task, and chat that are neither a bug repair, a planning request, nor information-only.

## Fixed split

The original 150 prompts retain their pre-existing 100 train / 50 test membership. The 30 benchmark prompts contribute 21 train / 9 test; the test count is fixed by category (bugfix 2, refactor 2, feature 2, Q&A 1, data 1, layperson 1). The 70 new prompts are balanced across Indonesian/English (35 each) and intent (18 fix, 18 plan-needed, 18 QA, 16 other); four prompts per intent are selected for test using SHA-256 ranking with seed `router-calib2-v1`, giving 54 train / 16 test. This produces exactly 175 train / 75 test (70/30). Membership was written before measuring the v2 baseline and is unchanged during tuning.

## Evaluation

Only test-split accuracy and confusion matrices are release metrics. Count a heavy-to-light mistake twice when tracking weighted error (`2 × heavy→light + light→heavy`). Keep the test rows fixed; use train prompts and explicit unit cases to tune. The router remains sticky for short follow-ups so “lanjut”/“okay, continue” inherit the prior session tier rather than causing a fresh light route.
