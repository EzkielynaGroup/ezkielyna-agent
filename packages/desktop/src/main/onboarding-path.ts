import { join } from "node:path"

const DEFAULT_PROJECT_DIR = "Default Project"

export function defaultProjectPath(input: {
  documentsPath: string
  userDataPath?: string
  hasUserDataOverride: boolean
}) {
  const base = input.hasUserDataOverride && input.userDataPath ? input.userDataPath : input.documentsPath
  return join(base, DEFAULT_PROJECT_DIR)
}
