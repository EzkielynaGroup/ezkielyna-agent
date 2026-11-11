// Ezkielyna Agent: tiny entry point that loads the real main bundle. A broken package (a missing module, for example) fails
// while ESM modules are being linked, before any of our handlers exist; Electron would then show its raw "A JavaScript
// error occurred in the main process" dialog. Loading through this file turns that into a short, friendly message.
// Release builds are checked by scripts/verify_packaged.sh, so this is the last line of defence, not the first.
import { app, dialog } from "electron"

const entry = "./index.js"

import(/* @vite-ignore */ entry).catch((error: unknown) => {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***").slice(0, 300)
  console.error(`Ezkielyna Agent failed to start: ${detail}`)
  if (process.env.EZK_TEST_HIDDEN !== "1") {
    const id = /^id/i.test(app.getLocale())
    dialog.showErrorBox(
      id ? "Ezkielyna Agent tidak bisa dibuka" : "Ezkielyna Agent could not start",
      id
        ? "Instalasi aplikasi ini tampaknya rusak. Unduh ulang dari https://ezkielyna.store/agent lalu pasang lagi."
        : "This installation looks damaged. Download it again from https://ezkielyna.store/agent and reinstall.",
    )
  }
  app.exit(1)
})
