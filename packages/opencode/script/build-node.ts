#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "none",
  // Ezkielyna Agent: same full minification as the CLI binary (script/build.ts), which the CLI e2e suite exercises.
  minify: true,
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    EZK_DEFAULT_UPDATE_URL: JSON.stringify(process.env.EZK_UPDATE_URL ?? ""),
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

// Separate Node child entry for the code_search indexer. Electron's server process queries the same database read-only.
await Bun.build({
  target: "node",
  entrypoints: ["./src/ezk/codeintel-worker.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "none",
  minify: true,
  naming: { entry: "codeintel-worker.js", chunk: "codeintel-worker-[name]-[hash].js", asset: "[name].[ext]" },
  external: ["jsonc-parser", "@lydell/node-pty"],
})

console.log("Build complete")
