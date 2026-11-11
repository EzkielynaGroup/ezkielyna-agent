// C5: the account sign-in method is labelled in one language (it was always the Indonesian text), and the Auto model likewise.
import { afterEach, describe, expect, test } from "bun:test"
import { accountLoginMethod } from "../../src/plugin/ezkielyna"

const keep = { EZK_LANG: process.env.EZK_LANG, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
afterEach(() => {
  for (const [k, v] of Object.entries(keep)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("account sign-in label", () => {
  test("English by default, Indonesian for id_*", () => {
    delete process.env.EZK_LANG
    process.env.LC_ALL = "en_US.UTF-8"
    expect(accountLoginMethod.label).toBe("Sign in with your Ezkielyna account")
    process.env.LC_ALL = "id_ID.UTF-8"
    expect(accountLoginMethod.label).toBe("Masuk dengan akun Ezkielyna")
  })
})
