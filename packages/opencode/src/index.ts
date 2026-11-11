const workerFlag = "--ezk-internal-codeindex-worker"
const args = process.argv.slice(1)
const workerAt = args.indexOf(workerFlag)

if (workerAt >= 0) {
  const { parseCodeIndexWorkerInput, runCodeIndexWorker } = await import("./ezk/codeintel-worker")
  await runCodeIndexWorker(parseCodeIndexWorkerInput(args[workerAt + 1])).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
} else {
  await import("./cli-main")
}
