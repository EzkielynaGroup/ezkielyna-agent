// Mock MCP servers for measurements: 3 servers x 40 tools with realistic-size schemas (no network, no real servers).
const VERBS = ["list", "get", "create", "update", "delete", "search", "archive", "export", "import", "sync"]
const NOUNS: Record<string, string[]> = {
  github: ["issue", "pull_request", "branch", "commit", "release", "label", "milestone", "workflow_run", "gist", "review"],
  postgres: ["table", "row", "index", "schema", "query", "migration", "role", "extension", "view", "trigger"],
  jira: ["ticket", "sprint", "board", "epic", "comment", "attachment", "worklog", "version", "component", "filter"],
}
const PARAMS = ["owner", "repo", "id", "title", "body", "state", "assignee", "labels", "page", "per_page", "sort", "direction"]

export function mockServer(server: string, count = 40) {
  const tools: Record<string, any> = {}
  const nouns = NOUNS[server] ?? NOUNS.github!
  for (let i = 0; i < count; i++) {
    const verb = VERBS[i % VERBS.length]!
    const noun = nouns[Math.floor(i / VERBS.length) % nouns.length]!
    const name = `${verb}_${noun}${i >= VERBS.length * nouns.length ? "_" + i : ""}`
    const props: Record<string, any> = {}
    for (let p = 0; p < 4 + (i % 5); p++) {
      props[PARAMS[(i + p) % PARAMS.length]!] = {
        type: p % 3 === 2 ? "integer" : "string",
        description: `The ${PARAMS[(i + p) % PARAMS.length]} used to ${verb} the ${noun.replace("_", " ")} in ${server}. Optional filters narrow the result.`,
      }
    }
    const key = `${server}_${name}`
    tools[key] = {
      server,
      description: `${verb[0]!.toUpperCase()}${verb.slice(1)} a ${noun.replace("_", " ")} in ${server}. Returns JSON with the fields of the ${noun.replace("_", " ")}; large results are paginated. Requires the ${server} credentials configured for this server. Use the filters to keep the result small.`,
      inputSchema: { jsonSchema: { type: "object", properties: props, required: Object.keys(props).slice(0, 2), additionalProperties: false } },
      execute: async (args: any) => ({ output: `${key} ${JSON.stringify(args)}` }),
    }
  }
  return tools
}

export const threeServers = () => ({ ...mockServer("github"), ...mockServer("postgres"), ...mockServer("jira") })
