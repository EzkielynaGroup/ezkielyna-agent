import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import type { KeyGroupModel } from "@opencode-ai/core/ezk/key-group"

type ModelRow = KeyGroupModel & { groups?: string[]; groupRatio?: Record<string, number> }

export function maskedApiKey(value: string) {
  return `sk-…${value.slice(-4)}`
}

export async function validateEzkielynaKey(key: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${EZK.baseURL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!response.ok) return
  const body: unknown = await response.json().catch(() => undefined)
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && "data" in body && Array.isArray(body.data)
      ? body.data
      : []
  const models = rows.flatMap((row): ModelRow[] => {
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") return []
    const groups = "groups" in row && Array.isArray(row.groups) ? row.groups.filter((item: unknown): item is string => typeof item === "string") : undefined
    const ratio =
      "groupRatio" in row && row.groupRatio && typeof row.groupRatio === "object"
        ? (row.groupRatio as Record<string, unknown>)
        : undefined
    const groupRatio = ratio
      ? Object.fromEntries(Object.entries(ratio).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
      : undefined
    return [{ id: row.id, groups, groupRatio }]
  })
  return models.length > 0 ? models : undefined
}

export async function validateAndSaveEzkielynaKey(input: {
  key: string
  save: (key: string) => Promise<unknown>
  refresh: () => Promise<unknown>
  fetcher?: typeof fetch
}) {
  const models = await validateEzkielynaKey(input.key, input.fetcher)
  if (!models) return
  await input.save(input.key)
  await input.refresh()
  return models
}
