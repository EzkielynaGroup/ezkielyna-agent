/** Remove inherited credentials before running task code or the agent; callers inject only the chosen benchmark key. */
export function safeEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i.test(name),
    ),
  )
}
