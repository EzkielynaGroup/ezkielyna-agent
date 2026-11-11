import config from "../../playwright.config"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
process.env.PLAYWRIGHT_SERVER_PORT = String(port)
process.env.OPENCODE_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

export default {
  ...config,
  testDir: ".",
  testIgnore: "unit/**",
  outputDir: "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  use: { ...config.use, video: "off" },
  reporter: [["html", { outputFolder: "../playwright-report/performance", open: "never" }], ["line"]],
  webServer: {
    ...config.webServer,
    command: `bun run build && bun run serve -- --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
  },
}
