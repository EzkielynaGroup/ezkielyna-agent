// CI packaging config: the desktop app's own electron-builder config with publishing switched off.
//
// CI artifacts are unsigned test builds, not releases. Without an explicit `publish: null`, electron-builder
// guesses a GitHub feed from GH_TOKEN or the git remote and bakes app-update.yml/latest*.yml pointing at this
// repository into the package (and crashes in createUpdateInfoTasks when the guess resolves to nothing).
// `-c.publish=null` on the command line does not work: the CLI keeps "null" as a string there.
//
// Run from packages/desktop: electron-builder --config ../../scripts/ci/electron-builder.ci.ts --linux AppImage
import config from "../../packages/desktop/electron-builder.config"

export default { ...config, publish: null }
