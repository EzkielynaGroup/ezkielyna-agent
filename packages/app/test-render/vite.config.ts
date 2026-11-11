import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import plugins from "../vite"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins,
  base: "./",
  logLevel: "warn",
  build: { outDir: process.env.U5_OUT ?? "/tmp/u5-render", emptyOutDir: true, minify: false },
})
