import { describe, expect, test } from "bun:test"
import { channelBadge } from "./channel-badge"

describe("channelBadge", () => {
  test("a production bundle built with the default dev channel shows no DEV badge", () => {
    expect(channelBadge({ channel: "dev", devBuild: false })).toBeUndefined()
  })
  test("a dev build (Vite dev server) keeps the DEV badge", () => {
    expect(channelBadge({ channel: "dev", devBuild: true })).toBe("dev")
  })
  test("VITE_EZK_DEV_BADGE=1 forces the DEV badge in a bundle", () => {
    expect(channelBadge({ channel: "dev", devBuild: false, force: "1" })).toBe("dev")
  })
  test("prod and unknown channels show nothing, beta keeps its label", () => {
    expect(channelBadge({ channel: "prod", devBuild: true })).toBeUndefined()
    expect(channelBadge({ channel: undefined, devBuild: false })).toBeUndefined()
    expect(channelBadge({ channel: "beta", devBuild: false })).toBe("beta")
  })
})
