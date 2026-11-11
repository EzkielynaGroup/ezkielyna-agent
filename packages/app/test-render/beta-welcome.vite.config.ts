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
    outDir: process.env.BETA_WELCOME_OUT ?? "/tmp/beta-welcome-render",
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: `${root}/beta-welcome.html` },
  },
})
