// Mock stdio MCP server for the wave B robustness tests. No network, no secrets.
//   --crash-after=<ms>   exit(1) that long after the first request
//   --spawn-child        also start `sleep 120` and write its pid to $EZK_CHILD_PID_FILE (tree-kill test)
//   --slow=<ms>          the `slow` tool sleeps that long
//   --hang               never answers initialize (startup timeout test)
// $EZK_START_LOG gets one line per start.
import fs from "node:fs"
import { spawn } from "node:child_process"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1]
if (process.env.EZK_START_LOG) fs.appendFileSync(process.env.EZK_START_LOG, "start\n")
if (process.argv.includes("--hang")) await new Promise(() => {})

if (process.argv.includes("--spawn-child") && process.env.EZK_CHILD_PID_FILE) {
  const child = spawn("sleep", ["120"], { stdio: "ignore" })
  fs.writeFileSync(process.env.EZK_CHILD_PID_FILE, String(child.pid))
}

const server = new Server({ name: "ezk-flaky", version: "1.0.0" }, { capabilities: { tools: {} } })
const crash = arg("crash-after")
server.setRequestHandler(ListToolsRequestSchema, () => {
  if (crash) setTimeout(() => process.exit(1), Number(crash))
  return Promise.resolve({
    tools: [
      { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
      { name: "slow", description: "Slow", inputSchema: { type: "object", properties: {} } },
    ],
  })
})
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "slow") await new Promise((r) => setTimeout(r, Number(arg("slow") ?? 5000)))
  return { content: [{ type: "text", text: "ok" }] }
})
await server.connect(new StdioServerTransport())
