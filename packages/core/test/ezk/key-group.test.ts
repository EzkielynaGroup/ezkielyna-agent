import { describe, expect, test } from "bun:test"
import { inferKeyGroup, shouldShowKeyGroupTip, type KeyGroupModel } from "../../src/ezk/key-group"

const standard = (id: string): KeyGroupModel => ({ id, groups: ["default", "member"], groupRatio: { default: 1 } })
const premium = (id: string): KeyGroupModel => ({ id, groups: ["premium"], groupRatio: { premium: 1.5 } })

describe("key group inference", () => {
  test("recognizes Hemat from the shared free group, even when Auto aliases are also listed", () => {
    const result = inferKeyGroup([
      { id: "auto", groups: ["free"], groupRatio: { free: 0.1 } },
      { id: "hy3", groups: ["free"], groupRatio: { free: 0.1 } },
      { id: "hy4-preview", groups: ["free"], groupRatio: { free: 0.1 } },
      { id: "hy4-preview-f", groups: ["free"], groupRatio: { free: 0.1 } },
    ])
    expect(result).toMatchObject({ id: "hemat", ratio: 0.1, modelCount: 4, estimated: true, showTip: true })
  })

  test("recognizes Standard and Premium using model-policy memberships and ratios", () => {
    expect(inferKeyGroup(["a", "b", "c", "d", "e", "f"].map((id) => standard(id)))).toMatchObject({
      id: "standard",
      ratio: 1,
      modelCount: 6,
      showTip: false,
    })
    expect(inferKeyGroup(["a", "b", "c", "d", "e", "f"].map((id) => premium(id)))).toMatchObject({
      id: "premium",
      ratio: 1.5,
      modelCount: 6,
      showTip: false,
    })
  })

  test("recognizes an alias-only Auto catalog", () => {
    expect(
      inferKeyGroup([
        { id: "auto", groups: ["free"] },
        { id: "default-model", groups: ["default", "member"] },
        { id: "balanced-model", groups: ["default", "member"] },
        { id: "fast-model", groups: ["default", "member"] },
      ]),
    ).toMatchObject({ id: "auto", modelCount: 4, estimated: true, showTip: true })
  })

  test("recognizes Flash from common flash memberships", () => {
    const groups = ["default", "member", "flash100", "flash300", "flash500", "flash1b"]
    expect(
      inferKeyGroup(["deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash"].map((id) => ({ id, groups }))),
    ).toMatchObject({ id: "flash", modelCount: 3, estimated: true })
  })

  test("shows the tip for Hemat or up to five visible models only", () => {
    expect(shouldShowKeyGroupTip(["a", "b", "c", "d", "e"].map((id) => standard(id)))).toBe(true)
    expect(shouldShowKeyGroupTip(["a", "b", "c", "d", "e", "f"].map((id) => standard(id)))).toBe(false)
    expect(shouldShowKeyGroupTip(["a", "b", "c", "d", "e", "f"].map((id) => ({ id, groups: ["free"] })))).toBe(true)
    expect(shouldShowKeyGroupTip([{ id: "unmapped" }])).toBe(true)
    expect(shouldShowKeyGroupTip([])).toBe(false)
    expect(inferKeyGroup([])).toBeUndefined()
  })
})
