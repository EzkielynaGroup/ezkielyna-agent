import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "store.ezkielyna.agent" : `store.ezkielyna.agent.${channel}`
const productName =
  channel === "prod" ? "Ezkielyna Agent" : `Ezkielyna Agent ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `AI coding agent for Ezkielyna API${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="store.ezkielyna">
    <name>Ezkielyna</name>
  </developer>

  <description>
    <p>
      Ezkielyna Agent helps you write and run code with your Ezkielyna API key. Based on OpenCode (MIT), (c) its authors.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="homepage">https://ezkielyna.store</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
