import { average, capitalize, sum } from "./utils"

export function report(title: string, scores: number[]) {
  return `${capitalize(title)}: total ${sum(scores)}, avg ${average(scores).toFixed(1)}`
}
