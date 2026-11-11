import { describe, expect, test } from "bun:test"
import { mapBetaHealth, shouldRunBetaHealthCheck, shouldShowBetaWelcome } from "../../../src/ezk/diag/beta-welcome"
import type { Check } from "../../../src/ezk/diag/doctor"

const checks = (input: { key?: "ok" | "fail"; gateway?: "ok" | "warn" | "fail" }, lang: "en" | "id" = "en"): Check[] => [
  { id: "key", status: input.key ?? "ok", label: lang === "id" ? "Kunci API" : "API key", detail: input.key === "fail" ? (lang === "id" ? "tidak ada. Jalankan ezkielyna sekali untuk mengisinya." : "not found. Set EZKIELYNA_API_KEY.") : (lang === "id" ? "ada" : "found") },
  { id: "gateway", status: input.gateway ?? "ok", label: lang === "id" ? "Koneksi" : "Connection", detail: input.gateway === "fail" ? (lang === "id" ? "tidak bisa dihubungi (timeout). Periksa koneksi internet Anda." : "cannot be reached (timeout). Check your internet connection.") : input.gateway === "warn" ? (lang === "id" ? "dilewati (belum ada kunci API)" : "skipped (no API key)") : (lang === "id" ? "terhubung (42 ms)" : "reachable (42 ms)") },
  { id: "disk", status: "ok", label: lang === "id" ? "Ruang disk kosong" : "Free disk space", detail: "12.0 GB" },
  { id: "trust", status: "warn", label: lang === "id" ? "Folder ini" : "This folder", detail: lang === "id" ? "belum dipercaya (/project): instruksi dan hooks proyek diabaikan." : "not trusted (/project): project instructions and hooks are ignored." },
]

describe("beta welcome and first-run health", () => {
  test("shows on each new beta version until that version is dismissed", () => {
    expect(shouldShowBetaWelcome("1.19.3-ezk.5", undefined)).toBe(true)
    expect(shouldShowBetaWelcome("1.19.3-ezk.5", "1.19.3-ezk.4")).toBe(true)
    expect(shouldShowBetaWelcome("1.19.3-ezk.5", "1.19.3-ezk.5")).toBe(false)
    expect(shouldShowBetaWelcome("1.19.3", undefined)).toBe(false)
    expect(shouldRunBetaHealthCheck("1.19.3-ezk.5", "1.19.3-ezk.4")).toBe(true)
    expect(shouldRunBetaHealthCheck("1.19.3-ezk.5", "1.19.3-ezk.5")).toBe(false)
  })

  test("maps a missing key to actionable Indonesian and English copy without exposing a key", () => {
    const id = mapBetaHealth(checks({ key: "fail", gateway: "warn" }, "id"), [], "id")
    const en = mapBetaHealth(checks({ key: "fail", gateway: "warn" }), [], "en")
    expect(id.find((item) => item.id === "key")?.detail).toContain("tidak ada")
    expect(id.find((item) => item.id === "group")?.detail).toContain("Tambahkan kunci API")
    expect(en.find((item) => item.id === "group")?.detail).toContain("Add an API key")
    expect(JSON.stringify(id)).not.toContain("sk-")
  })

  test("identifies the Hemat group and recommends Auto", () => {
    const models = ["a", "b", "c", "d"].map((id) => ({ id, groups: ["free"] }))
    const row = mapBetaHealth(checks({}), models, "id").find((item) => item.id === "group")
    expect(row?.status).toBe("warn")
    expect(row?.detail).toBe("Grup key Hemat hanya 4 model. Pakai key grup Auto untuk semua model yang tersedia.")
  })

  test("preserves the gateway failure and latency message from doctor", () => {
    const unreachable = mapBetaHealth(checks({ gateway: "fail" }), [], "en")
    expect(unreachable.find((item) => item.id === "gateway")?.detail).toContain("cannot be reached (timeout)")
    expect(unreachable.find((item) => item.id === "group")?.detail).toContain("until the model gateway is reachable")

    const ok = mapBetaHealth(checks({}), [{ id: "auto" }], "en")
    expect(ok.find((item) => item.id === "gateway")?.detail).toBe("reachable (42 ms)")
    expect(ok.find((item) => item.id === "group")?.detail).toContain("Auto key group · 1 models")
  })
})
