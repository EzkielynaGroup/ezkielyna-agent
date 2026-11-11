import { describe, expect, test } from "bun:test"
import { openSqlite } from "../../src/ezk/search/sqlite"

describe("cross-platform SQLite adapter", () => {
  test.each([
    ["win32", "C:\\Users\\owner\\AppData\\Local\\Ezkielyna\\search.db"],
    ["linux", "/home/owner/.local/share/ezkielyna/search.db"],
  ] as const)("passes %s database paths unchanged and enables a lock wait", async (platform, file) => {
    const calls: string[] = []
    let receivedPath = ""
    class DatabaseSyncMock {
      constructor(path: string) {
        receivedPath = path
      }
      exec(sql: string) {
        calls.push(sql)
      }
      prepare() {
        return { all: () => [], get: () => undefined, run: () => undefined }
      }
      close() {}
    }

    const db = await openSqlite(file, { runtime: "node", loadModule: async () => ({ DatabaseSync: DatabaseSyncMock }) })
    expect(receivedPath).toBe(file)
    expect(calls).toEqual(["PRAGMA busy_timeout = 5000"])
    db.close()
    expect(platform).toMatch(/win32|linux/)
  })

  test("uses Bun SQLite for CLI and initializes the connection", async () => {
    const db = await openSqlite(":memory:", { runtime: "bun" })
    db.exec("CREATE TABLE sample (value TEXT)")
    db.run("INSERT INTO sample VALUES (?)", "ok")
    expect(db.get<{ value: string }>("SELECT value FROM sample")?.value).toBe("ok")
    db.close()
  })
})
