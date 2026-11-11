import { listModels, pickDefaultModel, pickSmallModel, withEzkielyna, catalogProvider } from "../../packages/core/src/ezkielyna"
const flash = ["deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash"]
const mk = (ids: string[]) => (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as unknown as typeof fetch
const dir = "/tmp/ezk-flash-test-cache"
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FAIL", m, a, b); process.exit(1) } else console.log("ok  ", m) }
// 1) flash key sees only plan models, default stays deepseek-v4.1-flash when allowed
let r = await listModels({ key: "sk-x", cacheDir: dir, fetch: mk([...flash, "bge-m3", "edge-tts", "voyage-4"]) })
eq(r.ids, flash, "flash key: non-chat models filtered, only plan models")
eq(pickDefaultModel(r.ids), "minimax-m3.1-flash", "flash key: default = minimax-m3.1-flash")
r = await listModels({ key: "sk-a", cacheDir: dir, fetch: mk(["default-model", "fast-model", "balanced-model", "minimax-m3.1-flash"]) })
eq(pickDefaultModel(r.ids), "default-model", "default group: Auto = default-model")
eq(pickSmallModel(r.ids), "fast-model", "default group: small tasks use fast-model")
r = await listModels({ key: "sk-b", cacheDir: dir, fetch: mk(["auto", "hy3", "hy4-preview"]) })
eq(pickDefaultModel(r.ids), "auto", "free/Hemat key: auto")
r = await listModels({ key: "sk-c", cacheDir: dir, fetch: mk(flash) })
// 2) key whose plan lacks deepseek: falls back to first allowed (preferred list, then first)
r = await listModels({ key: "sk-y", cacheDir: dir, fetch: mk(["deepseek-v4.1-flash", "mimo-v2.6-flash"]) })
eq(pickDefaultModel(r.ids), "deepseek-v4.1-flash", "no minimax: falls back to deepseek-v4.1-flash")
r = await listModels({ key: "sk-y2", cacheDir: dir, fetch: mk(["mimo-v2.6-flash"]) })
eq(pickDefaultModel(r.ids), "mimo-v2.6-flash", "only mimo allowed: mimo-v2.6-flash")
r = await listModels({ key: "sk-z", cacheDir: dir, fetch: mk(["zzz-custom", "aaa-custom"]) })
eq(pickDefaultModel(r.ids), "zzz-custom", "unknown plan: first allowed model (gateway order)")
// 3) gateway down: cache for same key, then static fallback
const down = (async () => { throw new Error("offline") }) as unknown as typeof fetch
r = await listModels({ key: "sk-z", cacheDir: dir, fetch: down })
eq([r.source, r.ids], ["cache", ["zzz-custom", "aaa-custom"]], "offline: last good list for same key")
r = await listModels({ key: "sk-other", cacheDir: dir, fetch: down })
eq(r.source, "fallback", "offline, never seen: static fallback")
r = await listModels({ key: undefined, cacheDir: dir })
eq(r.source, "fallback", "no key: static fallback (no network)")
// 4) 403 (group denied) -> fallback, never throws
const denied = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch
r = await listModels({ key: "sk-q", cacheDir: dir, fetch: denied })
eq(r.source, "fallback", "403: fallback")
// 5) catalog hides upstream Zen providers
eq(Object.keys(withEzkielyna({ opencode: {}, "opencode-go": {}, openai: {} })).sort(), ["ezkielyna", "openai"], "opencode/opencode-go providers removed")
