import { app, dialog, shell } from "electron"
import { join } from "node:path"
import { EZK_UPDATE_URL, UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { createVerifiedBackend } from "./ezkielyna-updater"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { setAppQuitting } from "./windows"
import { nativeT } from "./native-translations"

const key = "ready"

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  // Ezkielyna Agent: updates are verified by ezkielyna-updater.ts (offline signature, HTTPS host pin, no downgrade, sha256);
  // electron-updater's feed handling is not used.
  const backend = createVerifiedBackend({
    base: EZK_UPDATE_URL,
    currentVersion: app.getVersion(),
    updatesDir: join(app.getPath("userData"), "updates"),
    openExternal: (url) => void shell.openExternal(url),
    quit: () => {
      // quitAndInstall closes all windows before emitting before-quit, so flag the quit first to keep window ids
      // persisted for restore.
      setAppQuitting()
      app.quit()
    },
    relaunch: (execPath) => app.relaunch({ execPath }),
  })
  logger.log("auto updater configured", { base: EZK_UPDATE_URL, currentVersion: app.getVersion() })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend,
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return {
          version: value.version,
          ...("installMode" in value && (value.installMode === "swap" || value.installMode === "page")
            ? { installMode: value.installMode }
            : {}),
        } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "error",
      message: nativeT("desktop.updater.dialog.checkFailed.message"),
      title: nativeT("desktop.updater.dialog.checkFailed.title"),
    })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: nativeT("desktop.updater.dialog.upToDate.message"),
      title: nativeT("desktop.updater.dialog.upToDate.title"),
    })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: nativeT(
      state.installMode === "swap" ? "desktop.updater.dialog.ready.swap" :
      state.installMode === "page" ? "desktop.updater.dialog.ready.page" :
      "desktop.updater.dialog.ready.message",
      { version: state.version },
    ),
    title: nativeT("desktop.updater.dialog.ready.title"),
    buttons: [
      nativeT(state.installMode === "page" ? "desktop.updater.dialog.openBeta" : "desktop.updater.dialog.restart"),
      nativeT("desktop.updater.dialog.later"),
    ],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}
