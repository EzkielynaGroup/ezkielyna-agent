export function selfcheckProblems(input: {
  untouchedPass: boolean
  solutionExit: number
  patchExit: number
  solvedPass: boolean
}) {
  return [
    input.untouchedPass ? "untouched repo already passes" : undefined,
    input.solutionExit !== 0 ? `solution.sh exited ${input.solutionExit}` : undefined,
    input.patchExit !== 0 ? `solution.patch failed to apply (${input.patchExit})` : undefined,
    input.solvedPass ? undefined : "reference solution fails verification",
  ].filter((problem): problem is string => Boolean(problem))
}
