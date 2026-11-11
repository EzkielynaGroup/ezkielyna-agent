import { expect, test } from "bun:test"
import { safeEnvironment } from "../lib/environment"

test("task and agent processes inherit ordinary settings but no credential variables", () => {
  expect(safeEnvironment({ PATH: "/bin", EZK_BENCH_KEY: "secret", OPENAI_API_KEY: "secret", AWS_SESSION_TOKEN: "secret", SSH_AUTH_SOCK: "/tmp/agent.sock", CUSTOMSECRET: "secret", CI: "1" })).toEqual({
    PATH: "/bin",
    CI: "1",
  })
})
