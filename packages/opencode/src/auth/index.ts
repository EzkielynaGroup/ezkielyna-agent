import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SECRET_SENTINEL, createSecretStore, type SecretStore } from "@opencode-ai/core/ezkielyna-secrets"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

/** Test seam: lets tests inject an in-memory secret store instead of the OS keychain. */
export const SecretStoreOverride: { current?: SecretStore } = {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    // Ezkielyna Agent: the Ezkielyna API key lives in the OS secret store when one is available; auth.json then only
    // holds a sentinel (and stays the 0600 file fallback otherwise). Other providers are untouched.
    const real = createSecretStore()
    const current = () => SecretStoreOverride.current ?? real
    const secrets = {
      get: (account: string) => current().get(account),
      set: (account: string, value: string) => current().set(account, value),
      delete: (account: string) => current().delete(account),
    }
    const ACCOUNT = "api-key"

    const readRaw = Effect.fn("Auth.readRaw")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
        } catch (err) {}
      }
      return (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
    })

    const all = Effect.fn("Auth.all")(function* () {
      const raw = yield* readRaw()
      // A key stored in plain text by an earlier run moves into the secret store the first time it is read.
      const plain = raw[EZK.providerID] as { type?: string; key?: string } | undefined
      if (!process.env.OPENCODE_AUTH_CONTENT && plain?.type === "api" && plain.key && plain.key !== SECRET_SENTINEL && secrets.set(ACCOUNT, plain.key)) {
        raw[EZK.providerID] = { ...plain, key: SECRET_SENTINEL }
        yield* fsys.writeJson(file, raw, 0o600).pipe(Effect.ignore)
        return Record.filterMap({ ...raw, [EZK.providerID]: plain }, (value) => Result.fromOption(decode(value), () => undefined))
      }
      const entry = raw[EZK.providerID] as { type?: string; key?: string } | undefined
      if (entry?.type === "api" && entry.key === SECRET_SENTINEL) {
        const real = secrets.get(ACCOUNT)
        const { [EZK.providerID]: _stub, ...rest } = raw
        return Record.filterMap(real ? { ...rest, [EZK.providerID]: { ...entry, key: real } } : rest, (value) =>
          Result.fromOption(decode(value), () => undefined),
        )
      }
      return Record.filterMap(raw, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* readRaw()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      const stored =
        norm === EZK.providerID && info.type === "api" && secrets.set(ACCOUNT, info.key) ? { ...info, key: SECRET_SENTINEL } : info
      yield* fsys
        .writeJson(file, { ...data, [norm]: stored }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* readRaw()
      delete data[key]
      delete data[norm]
      if (norm === EZK.providerID) secrets.delete(ACCOUNT)
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
