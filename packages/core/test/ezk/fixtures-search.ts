// Synthetic sessions DB (same table shapes as opencode.db: message + part) for the search tests and the 100k benchmark.
import { type Sqlite, openSqlite } from "../../src/ezk/search/sqlite"

export async function makeSource(file: string): Promise<Sqlite> {
  const db = await openSqlite(file)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
           CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);`)
  return db
}

export function insertMessage(db: Sqlite, o: { session: string; msg: string; part: string; role: string; text: string; t: number; extra?: Record<string, unknown> }) {
  db.run("INSERT INTO message VALUES(?,?,?,?,?)", o.msg, o.session, o.t, o.t, JSON.stringify({ role: o.role }))
  db.run("INSERT INTO part VALUES(?,?,?,?,?,?)", o.part, o.msg, o.session, o.t, o.t, JSON.stringify({ type: "text", text: o.text, ...o.extra }))
}

/** Deterministic pseudo-random text with a Zipf-like vocabulary. */
export function makeCorpus(seed = 1) {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const vocab = Array.from({ length: 6000 }, (_, i) => {
    const len = 3 + Math.floor(rnd() * 7)
    let w = ""
    for (let k = 0; k < len; k++) w += String.fromCharCode(97 + Math.floor(rnd() * 26))
    return w + (i % 7 === 0 ? "ing" : "")
  })
  const word = () => vocab[Math.floor(vocab.length * rnd() ** 2.2)]!
  const text = (n: number) => Array.from({ length: n }, word).join(" ")
  return { rnd, word, text, vocab }
}
