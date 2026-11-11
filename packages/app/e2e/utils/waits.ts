import { expect, type Locator, type Page } from "@playwright/test"

export const APP_READY_TIMEOUT = 30_000

export async function expectAppVisible(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: APP_READY_TIMEOUT })
}

export async function expectSessionTitle(page: Page, title: string) {
  // SessionRunHeader has its own heading; assert against the canonical timeline title.
  await expectAppVisible(page.locator('h1[data-slot="session-title-child"]'))
  await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText(title, { timeout: APP_READY_TIMEOUT })
}
