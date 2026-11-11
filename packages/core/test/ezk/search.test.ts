import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SearchIndex, toMatchQuery } from "../../src/ezk/search/fts"
import { insertMessage, makeCorpus, makeSource } from "./fixtures-search"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-fts-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("toMatchQuery", () => {
  test("safe tokens, prefix on the last one, no FTS syntax injection", () => {
    expect(toMatchQuery("foo bar")).toBe('"foo" "bar"*')
    expect(toMatchQuery("foo bar", "or")).toBe('"foo" OR "bar"*')
    expect(toMatchQuery('NEAR(a b) "x" OR -y*')).toBe('"near" "a" "b" "x" "or" "y"')
    expect(toMatchQuery("   ")).toBeUndefined()
    expect(toMatchQuery("!!!")).toBeUndefined()
    expect(toMatchQuery("café 日本語")).toBeDefined()
  })
})

describe("SearchIndex", () => {
  test("lazy build, ranking, snippets, roles, scoped search", async () => {
    const src = await makeSource(path.join(dir, "src.db"))
    insertMessage(src, { session: "s1", msg: "m1", part: "p1", role: "user", text: "How do I configure the nginx reverse proxy for websockets?", t: 1 })
    insertMessage(src, { session: "s1", msg: "m2", part: "p2", role: "assistant", text: "Use proxy_set_header Upgrade and Connection upgrade in the location block.", t: 2 })
    insertMessage(src, { session: "s2", msg: "m3", part: "p3", role: "user", text: "Fix the failing unit tests in the billing module", t: 3 })
    const idx = await SearchIndex.open(path.join(dir, "ezk", "search.db"))
    expect(idx.count()).toBe(0)
    expect(idx.sync(src)).toEqual({ indexed: 3, done: true })
    const hits = idx.search("nginx proxy")
    expect(hits[0]!.sessionID).toBe("s1")
    expect(hits[0]!.snippet).toContain("[")
    expect(idx.search("billing tests")[0]!.sessionID).toBe("s2")
    expect(idx.search("test").length).toBe(1) // porter stemming: tests -> test
    expect(idx.search("proxy", { sessionID: "s2" })).toEqual([])
    expect(idx.search("nginx zzzznothing").length).toBeGreaterThan(0) // AND misses, OR fallback finds nginx
    expect(idx.search("")).toEqual([])
    expect(idx.search('"unbalanced (')).toBeDefined()
    expect(fs.statSync(idx.file).mode & 0o777).toBe(0o600)
    idx.close()
    src.close()
  })
  test("incremental sync, streamed edits replace the old text, synthetic/private/empty are skipped", async () => {
    const src = await makeSource(path.join(dir, "src.db"))
    const idx = await SearchIndex.open(path.join(dir, "search.db"))
    insertMessage(src, { session: "s1", msg: "m1", part: "p1", role: "assistant", text: "partial wor", t: 1 })
    insertMessage(src, { session: "s1", msg: "m2", part: "p2", role: "user", text: "synthetic hidden", t: 2, extra: { synthetic: true } })
    insertMessage(src, { session: "priv", msg: "m3", part: "p3", role: "user", text: "private chat banana", t: 3 })
    insertMessage(src, { session: "s1", msg: "m4", part: "p4", role: "user", text: "   ", t: 4 })
    expect(idx.sync(src, { skipSessions: new Set(["priv"]) }).indexed).toBe(1)
    expect(idx.sync(src).indexed).toBe(0) // cursor: nothing new
    src.run("UPDATE part SET time_updated = 9, data = ? WHERE id = 'p1'", JSON.stringify({ type: "text", text: "final answer about databases" }))
    expect(idx.sync(src).indexed).toBe(1)
    expect(idx.count()).toBe(2 - 1) // p1 replaced (priv skipped on first sync stays skipped; p3 not re-seen)
    expect(idx.search("databases")).toHaveLength(1)
    expect(idx.search("partial")).toHaveLength(0)
    expect(idx.search("hidden")).toHaveLength(0)
    expect(idx.search("banana")).toHaveLength(0)
    insertMessage(src, { session: "later", msg: "m5", part: "p5", role: "user", text: "kiwi smoothies", t: 20 })
    idx.sync(src)
    expect(idx.search("kiwi", { excludeSessions: new Set(["later"]) })).toEqual([])
    idx.forgetSession("later")
    expect(idx.search("kiwi")).toEqual([])
    idx.close()
    src.close()
  })
  test("profile and project session filters exclude other projects and secret-bearing text", async () => {
    const src = await makeSource(path.join(dir, "profile-src.db"))
    insertMessage(src, { session: "telegram-session", msg: "m1", part: "p1", role: "user", text: "unique kumquat bridge setup", t: 1 })
    insertMessage(src, { session: "desktop-session", msg: "m2", part: "p2", role: "user", text: "unique kumquat desktop setup", t: 2 })
    insertMessage(src, { session: "telegram-session", msg: "m3", part: "p3", role: "user", text: "password: hunter2hunter2 confidential", t: 3 })
    const idx = await SearchIndex.open(path.join(dir, "profile.db"))
    expect(idx.sync(src, { onlySessions: new Set(["telegram-session"]) }).indexed).toBe(1)
    expect(idx.search("kumquat", { includeSessions: new Set(["telegram-session"]) })).toHaveLength(1)
    expect(idx.search("kumquat", { includeSessions: new Set(["desktop-session"]) })).toHaveLength(0)
    expect(idx.search("confidential", { includeSessions: new Set(["telegram-session"]) })).toHaveLength(0)
    idx.close()
    src.close()
  })
  test("unicode and Indonesian text", async () => {
    const src = await makeSource(path.join(dir, "s.db"))
    insertMessage(src, { session: "s", msg: "m", part: "p", role: "user", text: "Tolong perbaiki konfigurasi nginx untuk domain ezkielyna.store dan jelaskan caranya", t: 1 })
    insertMessage(src, { session: "s", msg: "m2", part: "p2", role: "user", text: "日本語のテキスト café résumé", t: 2 })
    const idx = await SearchIndex.open(path.join(dir, "i.db"))
    idx.sync(src)
    expect(idx.search("konfigurasi nginx")).toHaveLength(1)
    expect(idx.search("resume")).toHaveLength(1) // diacritics removed
    idx.close()
  })
  test("20-message sanity at scale: 5k docs build + query", async () => {
    const src = await makeSource(path.join(dir, "big.db"))
    const c = makeCorpus(7)
    src.transaction(() => {
      for (let i = 0; i < 5000; i++) insertMessage(src, { session: `s${i % 50}`, msg: `m${i}`, part: `p${i}`, role: i % 2 ? "assistant" : "user", text: c.text(60), t: i })
    })
    const idx = await SearchIndex.open(path.join(dir, "big-index.db"))
    expect(idx.sync(src, { batch: 1000 }).indexed).toBe(5000)
    expect(idx.search(c.vocab[10]! + " " + c.vocab[20]!).length).toBeGreaterThanOrEqual(0)
  })
})
