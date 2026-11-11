// Ezkielyna exec lane (T2): the extra bash parameters and tool texts of unified exec. Only offered when EZK_FEATURES has
// "+exec"; with the flag off none of this reaches the prompt, so the prompt bytes stay identical.
import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { LIMITS } from "@opencode-ai/core/ezk/exec/limits"

export const SHELL_NOTES = `# Long-running commands (unified exec)
- A command returns after yield_time_ms (default ${LIMITS.defaultYieldMs} ms) even if it is still running. Then the result contains a session_id and the command keeps running in the background.
- Read new output or answer a prompt with write_stdin(session_id, chars). Empty chars only waits for new output.
- Use run_in_background: true for dev servers and watchers, and monitor: true when you want new lines delivered to you automatically.
- exec_list shows your background commands; exec_stop stops one and everything it started.
- timeout is a hard limit only when you set it. At most ${LIMITS.maxProcesses} background commands run at once; unattended ones are stopped after ${LIMITS.idleMs / 60_000} minutes.`

export const WRITE_STDIN = `Send input to a running background command, or wait for its new output.
- session_id: the id returned by the bash tool or exec_list.
- chars: text to type, e.g. "y\\n" or "my-name\\n". Leave empty to only wait for new output.
- yield_time_ms: how long to wait for output (default ${LIMITS.defaultWriteYieldMs} ms after typing, ${LIMITS.defaultPollYieldMs} ms when only waiting).
Returns only the output produced since your last read.`

export const EXEC_LIST = "List the background commands started in this session, with their session_id, status and exit code."

export const EXEC_STOP = "Stop a background command and every process it started. Returns its last output."

export const writeStdinParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "The session_id of the background command" }),
  chars: Schema.optional(Schema.String).annotate({ description: "Text to write to stdin. Empty = only wait for output" }),
  yield_time_ms: Schema.optional(PositiveInt).annotate({ description: "How long to wait for output, in milliseconds" }),
})

export const execListParameters = Schema.Struct({})

export const execStopParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "The session_id of the background command to stop" }),
})
