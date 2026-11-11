import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ensureServerPassword } from "../ezkielyna-server-password"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless ezkielyna server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const auth = ensureServerPassword()
    if (auth.generated) console.log(`EZK_SERVER_PASSWORD was not set, so a random password was generated for this run.\nUser: ${auth.username}\nPassword: ${auth.password}`)
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`ezkielyna server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
