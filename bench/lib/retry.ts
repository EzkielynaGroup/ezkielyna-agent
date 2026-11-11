export type ProcessFailure = { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }

const NEVER_RETRY = /quota|insufficient (?:funds|balance)|balance too low|billing|context(?:_length| window| limit| overflow)|invalid api key|unauthori[sz]ed|forbidden|authentication failed|model not found/i
const INFRA_FAILURE = /\b429\b|\b5\d\d\b|econnreset|econnrefused|etimedout|eai_again|enetunreach|ehostunreach|socket hang up|connection reset|connection timed out|request timed out|upstream timeout|stream idle/i

/** Retry one failed process only when its failure is clearly infrastructure-related. */
export function retryableInfrastructureFailure(input: ProcessFailure) {
  const output = `${input.stderr}\n${input.stdout}`
  if (NEVER_RETRY.test(output)) return false
  if (input.timedOut) return true
  if (input.exitCode === 0) return false
  return INFRA_FAILURE.test(output)
}
