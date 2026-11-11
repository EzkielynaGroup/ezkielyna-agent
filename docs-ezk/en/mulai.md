# Quick start

Ezkielyna Agent is an AI assistant that can read files, edit them and run commands on your computer. You can use the **desktop app** or the **CLI** (terminal). Pick one, or use both.

## 1. Install the desktop app

Download from the download page: https://ezkielyna.store/agent

**macOS**
1. Open the `.dmg` and drag **Ezkielyna Agent** into Applications.
2. The first time, macOS may refuse to open it because the app is not notarized by Apple. Right-click the app → **Open** → **Open**. You only do this once.
3. If it is still blocked, open Terminal and run:
   ```
   xattr -dr com.apple.quarantine "/Applications/Ezkielyna Agent.app"
   ```
   Then open the app again.

**Windows**
1. Run the `.exe` installer.
2. If a blue "Windows protected your PC" screen appears, click **More info** → **Run anyway**.

**Linux**
- **AppImage**: `chmod +x Ezkielyna-Agent-*.AppImage`, then `./Ezkielyna-Agent-*.AppImage`.
- **deb** (Debian/Ubuntu): `sudo apt install ./ezkielyna-agent_*.deb`
- A Linux desktop build is not guaranteed in every release (coming soon). The CLI always works on Linux.

## 2. Install the CLI (terminal)

macOS, Linux, WSL:
```
curl -fsSL https://ezkielyna.store/agent/install.sh | sh
```

Windows (PowerShell):
```
irm https://ezkielyna.store/agent/install.ps1 | iex
```

The installer needs no sudo/admin, checks the signature and SHA-256 before installing, and puts the program in `~/.ezkielyna`. When it finishes, open a new terminal and type `ezkielyna` (short form: `ezk`).

## 3. First login

You need an **API key** (starts with `sk-`). Create one at https://api.ezkielyna.store/keys.

- **With a key**: on first launch choose the Ezkielyna provider and paste the key. In the CLI: `ezkielyna providers login`.
- **"Masuk dengan akun Ezkielyna"** (browser login, no key to paste): *(coming soon)*. The option appears once the server side is ready.

The key is stored on your computer. Never send your key to anyone, including support.

## 4. Your first task

Pick a project folder and type a normal request. Examples:

- `Explain what config.ts does`
- `Fix the typo in README.md`
- `Write a function that formats a number as Indonesian rupiah`

Before changing files or running commands, Ezkielyna **asks first**. Read it, then allow or reject. For the model, leave it on **Auto (Pintar)** at first, see [fitur.md](fitur.md).
