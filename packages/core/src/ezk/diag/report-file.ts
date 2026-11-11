export function bugReportFilename(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `ezkielyna-laporan-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`
}
