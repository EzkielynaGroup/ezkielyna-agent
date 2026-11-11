// C2: a typo is not a folder. Pure helpers of src/ezk/unknown-command.ts.
import { describe, expect, test } from "bun:test"
import { closestCommand, editDistance, namesOf, unknownCommandMessage } from "../../src/ezk/unknown-command"

const NAMES = ["run", "exec", "doctor", "upgrade", "uninstall", "trust", "models", "auth", "providers", "serve", "web", "session", "completion", "help"]

describe("unknown command (C2)", () => {
  test("the closest command is suggested for a typo", () => {
    expect(closestCommand("updgrade", NAMES)).toBe("upgrade")
    expect(closestCommand("ugrade", NAMES)).toBe("upgrade")
    expect(closestCommand("docter", NAMES)).toBe("doctor")
    expect(closestCommand("trsut", NAMES)).toBe("trust")
    expect(closestCommand("uninstal", NAMES)).toBe("uninstall")
    expect(closestCommand("UPGRADE", NAMES)).toBe("upgrade")
  })

  test("nothing is suggested for an unrelated word", () => {
    expect(closestCommand("my-project", NAMES)).toBeUndefined()
    expect(closestCommand("xyzzy", NAMES)).toBeUndefined()
  })

  test("message text, English and Indonesian, with and without a suggestion", () => {
    expect(unknownCommandMessage("updgrade", NAMES, "en")).toBe('Unknown command "updgrade". Did you mean "upgrade"? Run ezkielyna --help')
    expect(unknownCommandMessage("my-project", NAMES, "en")).toBe('Unknown command "my-project". Run ezkielyna --help')
    expect(unknownCommandMessage("updgrade", NAMES, "id")).toBe('Perintah "updgrade" tidak dikenal. Maksud Anda "upgrade"? Jalankan ezkielyna --help')
  })

  test("namesOf reads names and aliases from yargs command modules and skips the default command", () => {
    expect(namesOf([{ command: "run [message..]" }, { command: "providers", aliases: ["auth"] }, { command: "$0 [project]" }, { command: ["exec [prompt..]", "x"] }]).sort()).toEqual(["auth", "exec", "providers", "run", "x"])
  })

  test("edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3)
    expect(editDistance("", "abc")).toBe(3)
    expect(editDistance("same", "same")).toBe(0)
  })
})
