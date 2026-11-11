import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import plugins from "../vite"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  root,
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  plugins,
  base: "./",
  logLevel: "warn",
  build: {
    outDir: process.env.U5_OUT ?? "/tmp/polish-shell-render",
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: `${root}/polish-shell.html` },
  },
})
