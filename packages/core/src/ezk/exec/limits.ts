/** Small exec limits shared by prompt schema and the runtime process manager. */
export const LIMITS = {
  maxProcesses: 16,
  bufferBytes: 1_048_576,
  idleMs: 30 * 60_000,
  reapEveryMs: 60_000,
  /** finished processes kept for `exec_list` / `/tasks` */
  keepFinished: 32,
  killGraceMs: 3_000,
  minYieldMs: 250,
  maxYieldMs: 120_000,
  defaultYieldMs: 10_000,
  defaultWriteYieldMs: 1_000,
  defaultPollYieldMs: 5_000,
  /** monitor: a partial line longer than this is flushed as a line */
  maxLineBytes: 4_096,
}
