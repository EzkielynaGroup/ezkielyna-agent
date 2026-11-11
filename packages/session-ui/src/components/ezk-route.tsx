// Ezkielyna Agent v1.1: tiny bridge so the generic message UI can show how a turn's model was chosen
// ("auto light", "switched from X") without knowing about the app. The app registers a resolver that reads its own
// reactive store; with no resolver (stories, other hosts) nothing is shown.
export type EzkRouteResolver = (sessionID: string, messageID: string) => string | undefined

let resolver: EzkRouteResolver | undefined

export function setEzkRouteResolver(next: EzkRouteResolver | undefined) {
  resolver = next
}

export function ezkRouteLabel(sessionID: string, messageID: string): string | undefined {
  return resolver?.(sessionID, messageID)
}
