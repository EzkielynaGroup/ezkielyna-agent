// Ezkielyna Agent: the folder `run` works in. $PWD is inherited from the parent process, so a caller that starts the CLI
// with a `cwd` option (scripts, the benchmark harness, editors) leaves PWD pointing at ITS folder and `run` used to work
// there instead of the target (Bench v2 finding). The real working directory comes first; $PWD only when that is unreadable.
import path from "node:path"
import { resolveExecDirectory } from "@opencode-ai/core/ezk/exec/headless"
import { Filesystem } from "@/util/filesystem"

export function runRoot(env: Record<string, string | undefined> = process.env, cwd: () => string = () => process.cwd()) {
  return Filesystem.resolve(resolveExecDirectory({ cwd, pwd: env.PWD, resolve: path.resolve }) ?? ".")
}
