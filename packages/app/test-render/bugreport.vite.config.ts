import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import plugins from "../vite"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  root,
  plugins,
  base: "./",
  logLevel: "warn",
  build: {
    outDir: process.env.BUGREPORT_OUT ?? "/tmp/bugreport-render",
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: `${root}/bugreport.html` },
  },
})
