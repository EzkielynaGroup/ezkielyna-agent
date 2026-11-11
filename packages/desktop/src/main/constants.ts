import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// Ezkielyna Agent: auto-update stays off until an update server is configured (EZK_UPDATE_URL at build or run time,
// see updater.ts and README-EZK.md).
export const EZK_UPDATE_URL = (process.env.EZK_UPDATE_URL || import.meta.env.EZK_UPDATE_URL || "").replace(/\/+$/, "")
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && Boolean(EZK_UPDATE_URL)
