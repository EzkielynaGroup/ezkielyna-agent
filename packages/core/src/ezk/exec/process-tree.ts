// The pid-based process-tree helpers live in ../process-tree (one copy for the exec lane, MCP servers and the app shell).
export { descendants, killTree, alive, type KillOptions, type Runner } from "../process-tree"
