# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub's private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include what is affected (CLI, desktop app, installer, update check), the version (`ezkielyna --version`), your OS, and
steps to reproduce. Never include a real API key: rotate any key that ended up in logs or screenshots.

We aim to acknowledge reports within a few days. Please give us reasonable time to fix the problem before you disclose it.

## Scope

In scope: this repository's code, the `install` / `install.ps1` installers and the signed-update verification.
Out of scope: the Ezkielyna gateway and store websites (report those through <https://ezkielyna.store/support>), and
problems that exist unchanged in upstream OpenCode (report those to <https://github.com/anomalyco/opencode>).

## Threat model in short

The agent runs commands and edits files on your machine when you allow it. The permission prompt is the main control
("ask before acting" by default); the sandbox is experimental and off by default. Prompt injection from files or web pages
can still make the model ask for dangerous actions, so read shell commands before approving them.
The full review, including the local server, project trust, key storage and updates, is in
[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).
