import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { fetchFeatures, pollDeviceLogin, startDeviceLogin } from "@opencode-ai/core/ezkielyna-login"

// Ezkielyna Agent auth methods for the built-in "ezkielyna" provider.
//   1. API key (sk-...), always available.
//   2. "Masuk dengan akun Ezkielyna": device login against the store (core/src/ezkielyna-login.ts). Offered only when
//      GET {store}/api/store/agent/features says device_login is on (the server has a kill switch). The result is stored
//      exactly like a pasted key (keychain, never logged), with the non-secret account/device ids as metadata.

export const accountLoginMethod = {
  type: "oauth" as const,
  // one language per label, following LANG like `doctor` does
  get label() {
    return detectLang() === "id" ? "Masuk dengan akun Ezkielyna" : "Sign in with your Ezkielyna account"
  },
  async authorize() {
    const start = await startDeviceLogin({ deviceName: os.hostname().slice(0, 60), platform: `${process.platform}-${process.arch}` })
    return {
      method: "auto" as const,
      url: start.verificationUriComplete ?? start.verificationUri,
      instructions: `${detectLang() === "id" ? "Masukkan kode" : "Enter the code"}: ${start.userCode}`,
      async callback() {
        const result = await pollDeviceLogin(start)
        if (result.type === "success") return { type: "success" as const, key: result.apiKey, metadata: result.metadata }
        return { type: "failed" as const }
      },
    }
  },
}

// Runtime check: the features probe is cached for 6 hours so most starts make no request, and it never blocks startup.
const CAP_TTL_MS = 6 * 60 * 60 * 1000
let deviceLoginAvailable = EZK.accountLoginEnabled

async function probeDeviceLogin(): Promise<boolean> {
  const file = path.join(Global.Path.cache, "ezkielyna-features.json")
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { at: number; deviceLogin: boolean }
    if (Date.now() - cached.at < CAP_TTL_MS) return cached.deviceLogin
  } catch {}
  const features = await fetchFeatures()
  try {
    fs.mkdirSync(Global.Path.cache, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), deviceLogin: features.deviceLogin }))
  } catch {}
  return features.deviceLogin
}

export async function EzkielynaAuthPlugin(_input: PluginInput): Promise<Hooks> {
  if (!deviceLoginAvailable) void probeDeviceLogin().then((ok) => (deviceLoginAvailable = ok))
  return {
    auth: {
      provider: EZK.providerID,
      // Evaluated each time the connect dialog asks, so a finished probe shows up without a restart.
      get methods() {
        return [{ type: "api" as const, label: "Ezkielyna API key" }, ...(deviceLoginAvailable ? [accountLoginMethod] : [])]
      },
    },
  }
}
