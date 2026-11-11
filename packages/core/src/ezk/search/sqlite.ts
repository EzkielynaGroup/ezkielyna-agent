// Runtime-selected SQLite adapters keep Bun's CLI path separate from Electron's node:sqlite path.
export interface Sqlite {
  exec(sql: string): void
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
  run(sql: string, ...params: unknown[]): void
  transaction<T>(fn: () => T): T
  close(): void
}

type Runtime = "bun" | "node"
type ModuleLoader = (specifier: string) => Promise<any>

export async function openSqlite(
  file: string,
  opts: { readonly?: boolean; runtime?: Runtime; loadModule?: ModuleLoader } = {},
): Promise<Sqlite> {
  const runtime = opts.runtime ?? (typeof (globalThis as any).Bun !== "undefined" ? "bun" : "node")
  const specifier = runtime === "bun" ? "bun:sqlite" : "node:sqlite"
  const loadModule = opts.loadModule ?? ((name: string) => import(/* @vite-ignore */ /* webpackIgnore: true */ name))
  const mod = await loadModule(specifier)
  const db = runtime === "bun"
    ? new mod.Database(file, opts.readonly ? { readonly: true } : { create: true, readwrite: true })
    : new mod.DatabaseSync(file, { readOnly: !!opts.readonly })

  // FTS indexing can be opened by the CLI and desktop process at the same time.
  // Wait briefly for the other writer instead of failing immediately on Windows file locks.
  db.exec("PRAGMA busy_timeout = 5000")

  const cache = new Map<string, any>()
  const stmt = (sql: string) => {
    let statement = cache.get(sql)
    if (!statement) {
      statement = runtime === "bun" ? db.query(sql) : db.prepare(sql)
      cache.set(sql, statement)
    }
    return statement
  }
  return {
    exec: (sql) => void db.exec(sql),
    all: (sql, ...params) => stmt(sql).all(...params),
    get: (sql, ...params) => stmt(sql).get(...params) ?? undefined,
    run: (sql, ...params) => void stmt(sql).run(...params),
    transaction(fn) {
      db.exec("BEGIN")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        try {
          db.exec("ROLLBACK")
        } catch {}
        throw error
      }
    },
    close: () => db.close(),
  }
}
