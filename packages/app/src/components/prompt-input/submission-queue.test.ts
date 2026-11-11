import { expect, test } from "bun:test"
import { followupQueueDecision } from "./submission-queue"

test("queues normal followups when queue mode is selected", () => {
  expect(
    followupQueueDecision({ hasSession: true, mode: "normal", followupQueue: true, blockedByPermission: false }),
  ).toEqual({ queue: true, mode: "normal" })
})

test("preserves immediate shell behavior outside permission waits", () => {
  expect(
    followupQueueDecision({ hasSession: true, mode: "shell", followupQueue: true, blockedByPermission: false }),
  ).toEqual({ queue: false, mode: "shell" })
})

test("queues permission-wait instructions as normal followups, including shell mode", () => {
  expect(
    followupQueueDecision({ hasSession: true, mode: "shell", followupQueue: false, blockedByPermission: true }),
  ).toEqual({ queue: true, mode: "normal" })
})

test("does not queue prompts before a session exists", () => {
  expect(
    followupQueueDecision({ hasSession: false, mode: "normal", followupQueue: true, blockedByPermission: true }),
  ).toEqual({ queue: false, mode: "normal" })
})
