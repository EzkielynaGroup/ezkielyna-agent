import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Ezkielyna Agent: own app ids so it installs next to a stock OpenCode.
const APP_IDS = {
  dev: "store.ezkielyna.agent.dev",
  beta: "store.ezkielyna.agent.beta",
  prod: "store.ezkielyna.agent",
} as const

// Auto-update feed (generic provider = any static web server). Empty = no feed, updater disabled.
const updateUrl = (process.env.EZK_UPDATE_URL ?? "").replace(/\/+$/, "")

const getBase = (appId: string): Configuration => ({
  // Versioned (immutable) names: the download host caches them for a year.
  artifactName: "ezkielyna-agent-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  // Ezkielyna Agent size trimming (measured in QUALITY.md): no source maps, no type declarations, no TypeScript sources
  // of dependencies. (drizzle-orm's other database dialects cannot be dropped: its core imports them.)
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/opencode-cli*",
    "!**/*.map",
    "!**/*.d.ts",
    "!**/*.d.cts",
    "!**/*.d.mts",
    "!**/node_modules/effect/src/**",
  ],
  // Only the two UI languages ship; Chromium's other ~55 locale packs are dropped.
  electronLanguages: ["en-US", "id"],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    // Ezkielyna Agent: no Apple Developer account. electron-builder skips real signing (identity: null);
    // scripts/adhoc-sign-mac.sh then applies an ad-hoc signature (codesign -s -) so Apple Silicon will launch it.
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: false,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: false,
  },
  protocols: {
    name: "Ezkielyna Agent",
    schemes: ["ezkielyna"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Ezkielyna Agent Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "ezkielyna-agent-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Ezkielyna Agent Beta",
        protocols: { name: "Ezkielyna Agent Beta", schemes: ["ezkielyna"] },
        ...(updateUrl ? { publish: { provider: "generic", url: updateUrl, channel: "latest" } } : {}),
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "ezkielyna-agent-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Ezkielyna Agent",
        protocols: { name: "Ezkielyna Agent", schemes: ["ezkielyna"] },
        // Never publish to upstream GitHub. Generic feed only when EZK_UPDATE_URL is set.
        ...(updateUrl ? { publish: { provider: "generic", url: updateUrl, channel: "latest" } } : {}),
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "ezkielyna-agent", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
