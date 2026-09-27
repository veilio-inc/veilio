import { test, expect } from '@playwright/test'

// Builds before spec 018 kept "save locally" maps as plain JSON under
// `veilio_local_maps` - real identifier names, readable by anything with the
// browser profile. They are not migrated; the app deletes them on its first
// load, before rendering, whichever page that load is.

const LEGACY = JSON.stringify([
  { id: 'old', name: 'billing', savedAt: '2026-01-01', map: { __CLS__1: 'PaymentGateway' } },
])

for (const path of ['/', '/dashboard']) {
  test(`a load of ${path} deletes plaintext maps an earlier build left`, async ({ page }) => {
    await page.goto(path)
    // As an earlier build left it: written before this build's code ran.
    await page.evaluate((v) => localStorage.setItem('veilio_local_maps', v), LEGACY)
    await page.reload()
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('veilio_local_maps')))
      .toBeNull()
  })
}
