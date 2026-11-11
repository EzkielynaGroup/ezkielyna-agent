import { describe, expect, test } from "bun:test"
import { classifyGatewayError, detectLang, friendlyGatewayError } from "../../src/ezkielyna-errors"

// Bodies copied from real api.ezkielyna.store answers (21 Oct 2026), request ids shortened.
const BAD_KEY = '{"error":{"code":"","message":"Invalid token (request id: 2026)","type":"new_api_error"}}'
const GROUP = '{"error":{"code":"","message":"无权访问 flash100 分组 (request id: 2026)","type":"new_api_error"}}'
const NO_MODEL = '{"error":{"code":"model_not_found","message":"No available channel for model nonexistent-model-x under group default (distributor) (request id: 2026)","type":"new_api_error"}}'

describe("gateway error mapping", () => {
  test("bad or exhausted key", () => {
    expect(classifyGatewayError({ status: 401, responseBody: BAD_KEY })?.kind).toBe("bad_key")
    expect(friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "id")).toContain("Kunci API tidak valid")
    expect(friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "en")).toContain("invalid, deleted, or out of balance")
  })
  test("group not allowed", () => expect(classifyGatewayError({ status: 403, responseBody: GROUP })?.kind).toBe("group_denied"))
  test("model not available names the model", () => {
    expect(classifyGatewayError({ status: 503, responseBody: NO_MODEL })).toEqual({ kind: "model_missing", model: "nonexistent-model-x" })
    expect(friendlyGatewayError({ status: 503, responseBody: NO_MODEL }, "id")).toContain("nonexistent-model-x")
  })
  test("balance, plan cap, rate limit, busy, network", () => {
    expect(classifyGatewayError({ status: 403, responseBody: '{"error":{"message":"用户额度不足, 剩余额度: 0"}}' })?.kind).toBe("no_balance")
    expect(classifyGatewayError({ status: 429, responseBody: '{"error":{"message":"daily limit reached for your plan"}}' })?.kind).toBe("plan_cap")
    expect(classifyGatewayError({ status: 429, responseBody: "{}" })?.kind).toBe("rate_limit")
    expect(classifyGatewayError({ status: 502, responseBody: "<html>bad gateway</html>" })?.kind).toBe("busy")
    expect(classifyGatewayError({ message: "Cannot connect to API: getaddrinfo ENOTFOUND api.ezkielyna.store" })?.kind).toBe("network")
    expect(friendlyGatewayError({ status: 429, responseBody: '{"error":{"message":"daily limit reached for your plan"}}' }, "en")).toContain("https://ezkielyna.store")
  })
  test("unknown errors are left alone", () => expect(friendlyGatewayError({ status: 400, responseBody: '{"error":{"message":"bad param"}}' })).toBeUndefined())
  test("language detection", () => {
    expect(detectLang({ LANG: "id_ID.UTF-8" })).toBe("id")
    expect(detectLang({ LANG: "id-ID" })).toBe("id")
    expect(detectLang({ LANG: "en_US.UTF-8" })).toBe("en")
    expect(detectLang({ EZK_LANG: "id", LANG: "en_US.UTF-8" })).toBe("id")
  })
})

import { streamCutMessage as __streamCut } from "../../src/ezkielyna-errors"
import { test as __t, expect as __e } from "bun:test"
__t("streamCutMessage: ID and EN wording (ezk-netcut)", () => {
  __e(__streamCut("id")).toBe("Koneksi ke gateway terputus di tengah jawaban. Coba lagi.")
  __e(__streamCut("en")).toBe("The connection to the gateway dropped in the middle of the answer. Please try again.")
})
