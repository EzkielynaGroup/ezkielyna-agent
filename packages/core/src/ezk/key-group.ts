import { EZK } from "../ezkielyna-brand"

export type KeyGroupId = "hemat" | "standard" | "premium" | "auto" | "flash"

export type KeyGroupModel = {
  id: string
  groups?: readonly string[]
  groupRatio?: Readonly<Record<string, number>>
}

export type KeyGroupSummary = {
  id: KeyGroupId
  /** Group ratio from the model-policy document, when published. */
  ratio?: number
  modelCount: number
  estimated: true
  showTip: boolean
}

const SMALL_CATALOG_LIMIT = 5
const isAlias = (id: string) => Object.prototype.hasOwnProperty.call(EZK.autoModels, id)

function commonGroups(models: readonly KeyGroupModel[]) {
  const groups = models.map((model) => new Set(model.groups ?? []))
  if (groups.length === 0 || groups.some((set) => set.size === 0)) return new Set<string>()
  const [first, ...rest] = groups
  return new Set([...first!].filter((group) => rest.every((set) => set.has(group))))
}

function ratioFor(models: readonly KeyGroupModel[], groups: readonly string[]) {
  for (const model of models) {
    for (const group of groups) {
      const ratio = model.groupRatio?.[group]
      if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) return ratio
    }
  }
}

/** Infer a display-only key group from the models already returned for this key. */
export function inferKeyGroup(models: readonly KeyGroupModel[]): KeyGroupSummary | undefined {
  if (models.length === 0) return

  const aliases = models.filter((model) => isAlias(model.id))
  const concrete = models.filter((model) => !isAlias(model.id))
  let id: KeyGroupId | undefined
  let ratioGroups: string[] = []

  // A list consisting only of gateway aliases has no named-model group to intersect.
  if (aliases.length === models.length) {
    id = "auto"
  } else {
    const groups = commonGroups(concrete)
    const flashGroups = [...groups].filter((group) => /^flash\w*$/i.test(group)).sort()
    if (groups.has("free")) {
      id = "hemat"
      ratioGroups = ["free"]
    } else if (groups.has("premium")) {
      id = "premium"
      ratioGroups = ["premium"]
    } else if (flashGroups.length) {
      id = "flash"
      ratioGroups = flashGroups
    } else if (groups.has("default") || groups.has("member")) {
      id = "standard"
      ratioGroups = ["default", "member"]
    } else if (concrete.every((model) => /flash/i.test(model.id))) {
      // Some policy snapshots omit the named flash group while the key's actual list still makes the tier clear.
      id = "flash"
    }
  }

  if (!id) return
  return {
    id,
    ratio: ratioFor(models, ratioGroups),
    modelCount: models.length,
    estimated: true,
    showTip: id === "hemat" || models.length <= SMALL_CATALOG_LIMIT,
  }
}

/** Hemat always needs context; otherwise keep the hint for genuinely small visible catalogs. */
export function shouldShowKeyGroupTip(models: readonly KeyGroupModel[]): boolean {
  return models.length > 0 && (models.length <= SMALL_CATALOG_LIMIT || inferKeyGroup(models)?.id === "hemat")
}
