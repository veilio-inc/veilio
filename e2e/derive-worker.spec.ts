import { test, expect } from '@playwright/test'
import { anonymize } from './helpers.js'
import { buildVeilioFile } from './helpers-veilio-file.js'

// ROADMAP E11 (specs/007-e11-derive-off): jsdom cannot show a frozen main
// thread, so these assertions only mean something in a real browser.
//
// MAX_ITERATIONS (src/lib/kdf.ts, not exported - a private ceiling on
// untrusted input) is 4_000_000 at the time of writing. Importing a file
// declaring it is this suite's "hostile file" case (US2) and gives the
// longest derive the app allows without touching kdf.ts. Measured directly
// against this repo's Chromium build, even that ceiling still completes in
// well under 100ms - modern native WebCrypto is fast - so on its own it
// leaves no reliably observable window. CPU throttling via CDP (the same
// technique quickstart.md's manual check describes doing by hand in
// devtools) creates one without touching the app or its parameters.
const MAX_ITERATIONS = 4_000_000

/**
 * Four million PBKDF2 iterations is the point of this file, and it is why the
 * default thirty-second budget does not fit everywhere.
 *
 * Natively these two tests take about twenty seconds together. Inside a
 * container on an emulated CPU the same derive runs several times slower and
 * the budget is gone - reliably, not occasionally, and the shape says so:
 * every retry failed at a DIFFERENT step (waiting for the file chooser, then
 * the click, then `derive-busy` never clearing). A logic fault fails in the
 * same place each time; a uniformly slow run fails wherever the clock happens
 * to run out.
 *
 * The budget is raised rather than the iteration count lowered, because the
 * iteration count IS the subject: the assertion is that the page keeps
 * repainting while a deliberately hostile file is derived, and a cheaper file
 * would not exercise that at all.
 */
test.describe.configure({ timeout: 120_000 })
const PASSPHRASE = 'e2e-derive-worker-passphrase'
const CPU_THROTTLE_RATE = 40

async function throttleCpu(page: import('@playwright/test').Page): Promise<void> {
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE_RATE })
}

async function importHostileFile(
  page: import('@playwright/test').Page,
  map: Record<string, string>
) {
  const hostileFile = await buildVeilioFile(map, PASSPHRASE, MAX_ITERATIONS)
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import .veilio' }).click()
  const fileChooser = await fileChooserPromise
  // Registered before setFiles resolves the onchange handler: that handler
  // calls prompt() synchronously, and a dialog with no listener yet attached
  // is auto-dismissed by Playwright, which reads back as an empty passphrase
  // and silently aborts the import before it ever starts deriving.
  page.once('dialog', (dialog) => dialog.accept(PASSPHRASE))
  await fileChooser.setFiles({
    name: 'hostile.veilio',
    mimeType: 'application/json',
    buffer: Buffer.from(hostileFile),
  })
}

test('the page keeps repainting during a real derive, and the artifact still round-trips', async ({
  page,
}) => {
  await page.goto('/')
  await anonymize(page)
  await throttleCpu(page)

  // A requestAnimationFrame loop only advances if the main thread is free to
  // run it - this is the actual, direct proof a synchronous main-thread
  // derive would fail, not an inference from wall-clock time.
  await page.evaluate(() => {
    const w = window as unknown as { __rafCount: number }
    w.__rafCount = 0
    const tick = () => {
      w.__rafCount++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await importHostileFile(page, { __FN__1: 'settleInvoice' })

  await expect(page.getByTestId('derive-busy')).toBeVisible()

  const rafDuringDerive = await page.evaluate(async () => {
    const w = window as unknown as { __rafCount: number }
    const before = w.__rafCount
    await new Promise((resolve) => setTimeout(resolve, 300))
    return w.__rafCount - before
  })
  // Any measurable progress proves the main thread was free to run rAF
  // callbacks throughout the window - a blocked thread would report 0.
  expect(rafDuringDerive).toBeGreaterThan(0)

  await expect(page.getByTestId('derive-busy')).toBeHidden({ timeout: 90_000 })
  await expect(page.getByText('1 symbols')).toBeVisible()
})

test('Cancel stops an in-flight derive and returns the UI to idle', async ({ page }) => {
  await page.goto('/')
  await anonymize(page)
  await throttleCpu(page)

  await importHostileFile(page, { __FN__1: 'settleInvoice' })

  await expect(page.getByTestId('derive-busy')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await expect(page.getByTestId('derive-busy')).toBeHidden()
  // Cancelled, not completed: the hostile map must not have been loaded.
  await expect(page.getByText('1 symbols')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Import .veilio' })).toBeEnabled()
})
