import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

// Ezkielyna Agent: no models.dev snapshot is bundled. Every upstream provider is disabled in this fork and the
// Ezkielyna provider and its models are injected at runtime (core/src/ezkielyna.ts), so the multi-megabyte catalog
// would only add size and a build-time network dependency. Set MODELS_DEV_API_JSON to a file to bundle one anyway.
export const modelsData = process.env.MODELS_DEV_API_JSON ? await Bun.file(process.env.MODELS_DEV_API_JSON).text() : "{}"
console.log(process.env.MODELS_DEV_API_JSON ? "Loaded models.dev snapshot" : "No models.dev snapshot bundled")
