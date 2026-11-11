import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { SECRET_SENTINEL, type SecretStore } from "@opencode-ai/core/ezkielyna-secrets"
import { Auth, SecretStoreOverride } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  describe("Ezkielyna key in the OS secret store", () => {
    const KEY = "sk-" + "abcdefghijklmnopqrstuvwxyz0123456789ABCD"
    const authFile = () => path.join(Global.Path.data, "auth.json")
    const memory = () => {
      const data = new Map<string, string>()
      const store: SecretStore = { backend: "keychain" as never, get: (a) => data.get(a), set: (a, v) => (data.set(a, v), true), delete: (a) => void data.delete(a) }
      return { data, store }
    }
    const withStore = (store: SecretStore | undefined) => {
      SecretStoreOverride.current = store
    }

    it.instance("set keeps only a sentinel in auth.json; all() returns the real key; remove clears the store", () =>
      Effect.gen(function* () {
        const m = memory()
        withStore(m.store)
        yield* Effect.addFinalizer(() => Effect.sync(() => withStore(undefined)))
        const auth = yield* Auth.Service
        yield* auth.set("ezkielyna", { type: "api", key: KEY })
        const onDisk = fs.readFileSync(authFile(), "utf8")
        expect(onDisk).not.toContain(KEY)
        expect(onDisk).toContain(SECRET_SENTINEL)
        expect(m.data.get("api-key")).toBe(KEY)
        const all = yield* auth.all()
        expect(all["ezkielyna"]).toEqual({ type: "api", key: KEY })
        yield* auth.remove("ezkielyna")
        expect(m.data.size).toBe(0)
        expect((yield* auth.all())["ezkielyna"]).toBeUndefined()
      }),
    )

    it.instance("a plain-text key from an earlier run migrates into the store on first read", () =>
      Effect.gen(function* () {
        const m = memory()
        withStore(m.store)
        yield* Effect.addFinalizer(() => Effect.sync(() => withStore(undefined)))
        fs.mkdirSync(Global.Path.data, { recursive: true })
        fs.writeFileSync(authFile(), JSON.stringify({ ezkielyna: { type: "api", key: KEY }, other: { type: "api", key: "sk-" + "other-provider-key" } }), { mode: 0o600 })
        const auth = yield* Auth.Service
        const first = yield* auth.all()
        expect(first["ezkielyna"]).toEqual({ type: "api", key: KEY })
        expect(m.data.get("api-key")).toBe(KEY)
        const disk = JSON.parse(fs.readFileSync(authFile(), "utf8"))
        expect(disk.ezkielyna.key).toBe(SECRET_SENTINEL)
        expect(disk.other.key).toBe("sk-" + "other-provider-key") // other providers untouched
        expect((yield* auth.all())["ezkielyna"]).toEqual({ type: "api", key: KEY })
      }),
    )

    it.instance("no secret store: the key stays in the 0600 file", () =>
      Effect.gen(function* () {
        withStore({ backend: "none", get: () => undefined, set: () => false, delete: () => {} })
        yield* Effect.addFinalizer(() => Effect.sync(() => withStore(undefined)))
        const auth = yield* Auth.Service
        yield* auth.set("ezkielyna", { type: "api", key: KEY })
        expect(fs.readFileSync(authFile(), "utf8")).toContain(KEY)
        if (process.platform !== "win32") expect(fs.statSync(authFile()).mode & 0o777).toBe(0o600)
        expect((yield* auth.all())["ezkielyna"]).toEqual({ type: "api", key: KEY })
        yield* auth.remove("ezkielyna")
      }),
    )

    it.instance("sentinel with an empty store drops the entry instead of leaking the sentinel as a key", () =>
      Effect.gen(function* () {
        withStore(memory().store)
        yield* Effect.addFinalizer(() => Effect.sync(() => withStore(undefined)))
        fs.mkdirSync(Global.Path.data, { recursive: true })
        fs.writeFileSync(authFile(), JSON.stringify({ ezkielyna: { type: "api", key: SECRET_SENTINEL } }), { mode: 0o600 })
        expect((yield* (yield* Auth.Service).all())["ezkielyna"]).toBeUndefined()
      }),
    )
  })
})
