import type { TestProfileMetadata } from "../preload/types"

export const DEFAULT_EZK_BASE_URL = "https://api.ezkielyna.store/v1"

function normalizedBaseURL(value: string) {
  try {
    return new URL(value).toString().replace(/\/$/, "")
  } catch {
    return value.trim().replace(/\/$/, "")
  }
}

function baseHost(value: string) {
  try {
    return new URL(value).host || "URL kustom"
  } catch {
    return "URL kustom"
  }
}

export function resolveTestProfile(env: Record<string, string | undefined>): TestProfileMetadata {
  const userDataOverride = env.EZK_USER_DATA_DIR?.trim()
  const baseURL = env.EZKIELYNA_BASE_URL?.trim() || DEFAULT_EZK_BASE_URL
  const customBaseURL = normalizedBaseURL(baseURL) !== normalizedBaseURL(DEFAULT_EZK_BASE_URL)

  return {
    enabled: Boolean(userDataOverride) || customBaseURL,
    apiHost: baseHost(baseURL),
  }
}

export function desktopWindowTitle(profile: TestProfileMetadata) {
  return profile.enabled ? "Ezkielyna Agent — Profil uji" : "Ezkielyna Agent"
}
