import fs from "node:fs"

type Callback<T> = (err: Error | null, value?: T) => void

export function readJson(file: string, cb: Callback<unknown>) {
  fs.readFile(file, "utf8", (err, text) => {
    if (err) return cb(err)
    try {
      cb(null, JSON.parse(text))
    } catch (parseError) {
      cb(parseError as Error)
    }
  })
}

export function writeJson(file: string, data: unknown, cb: Callback<void>) {
  fs.writeFile(file, JSON.stringify(data, null, 2), (err) => cb(err ?? null))
}
