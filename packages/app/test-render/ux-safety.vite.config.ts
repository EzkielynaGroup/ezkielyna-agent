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
    outDir: process.env.UX_SAFETY_OUT ?? "/tmp/ux-safety-render",
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: `${root}/ux-safety.html` },
  },
})
