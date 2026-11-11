// Ezkielyna Agent ezk.8: the DEV/BETA channel badge in the title bar.
// A packaged release must never show "DEV", even when it was built without OPENCODE_CHANNEL (the Vite define then falls
// back to "dev"). The `dev` badge is therefore shown only for a real dev build (Vite dev server, `import.meta.env.DEV`)
// or when it is forced with VITE_EZK_DEV_BADGE=1 at build time. `beta` keeps its label.
export function channelBadge(input: { channel?: string; devBuild: boolean; force?: string }): "dev" | "beta" | undefined {
  if (input.channel === "beta") return "beta"
  if (input.channel === "dev" && (input.devBuild || input.force === "1")) return "dev"
  return undefined
}
