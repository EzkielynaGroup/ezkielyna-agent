// Sandbox e2e: the real `ezkielyna serve` against the mock gateway; the scripted model runs a shell command that
// writes outside the project. With EZK_FEATURES=+sandbox the write is blocked and the tool result explains it;
// without the flag nothing changes (same tool schema, the write happens). Needs a working bwrap for the first case.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findBwrap } from "@opencode-ai/core/ezk/sandbox"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const MODEL = "deepseek-v4.1-flash"
const available = process.platform === "linux" && Boolean(findBwrap().path)

let gw: ReturnType<typeof startMockGateway> | undefined
let srv: Server | undefined
let outside: string | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  if (outside) fs.rmSync(outside, { recursive: true, force: true })
  srv = gw = outside = undefined
})

async function scenario(features: string) {
  outside = fs.mkdtempSync(path.join(os.homedir(), ".ezk-sbx-e2e-"))
  const target = path.join(outside, "out.txt")
  gw = startMockGateway({
    models: { [KEY]: [MODEL] },
    script: {
      [MODEL]: [
        { ok: true, tool: { name: "bash", args: { command: `echo hello > ${target}`, description: "Write a file" } } },
        { ok: true, text: "done" },
      ],
    },
  })
  srv = await startServer({
    baseURL: gw.baseURL,
    key: KEY,
    config: { permission: { bash: "allow", external_directory: "allow" } },
    env: { EZK_FEATURES: features, EZK_TRUST_PROJECT: "1", SHELL: "/bin/bash" },
  })
  const session = await newSession(srv)
  await prompt(srv, session.id, "write the file", MODEL)
  const messages = await srv.api<
    { parts: { type: string; tool?: string; state?: { output?: string; metadata?: Record<string, unknown> } }[] }[]
  >("GET", `/session/${session.id}/message`)
  const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "bash")
  const bashSchema = gw.requests[0]?.body.tools?.find(
    (item: { function?: { name?: string } }) => item.function?.name === "bash",
  )
  return { target, tool, properties: Object.keys(bashSchema?.function?.parameters?.properties ?? {}) }
}

describe("sandbox e2e (real server, mock gateway)", () => {
  test.skipIf(!available)(
    "+sandbox: a write outside the project is blocked and explained",
    async () => {
      const { target, tool, properties } = await scenario("+sandbox")
      expect(properties).toContain("sandbox_permissions")
      expect(tool?.state?.metadata).toMatchObject({ sandbox: "bwrap" })
      expect(tool?.state?.output).toContain("Read-only file system")
      expect(tool?.state?.output).toContain("<sandbox>")
      expect(fs.existsSync(target)).toBe(false)
    },
    120_000,
  )

  test("flag off: unchanged schema and behaviour", async () => {
    const { target, tool, properties } = await scenario("")
    expect(properties).toContain("command")
    expect(properties).not.toContain("sandbox_permissions")
    expect(tool?.state?.metadata).not.toHaveProperty("sandbox")
    expect(fs.readFileSync(target, "utf8")).toBe("hello\n")
  }, 120_000)
})
