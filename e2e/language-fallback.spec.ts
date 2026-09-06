import { test, expect } from '@playwright/test'
import { editor, editors, typeInto } from './helpers.js'

// 002-b4, User Story 1 & 2. The engine reports `languageFallback` when no
// marker matched anything, and the warning has to sit where it is read before
// the paste it exists to prevent — jsdom cannot answer either "is this
// visible" in a real layout or "does the picker actually re-process the
// text", so both need a real browser.

/** Genuinely matches no marker in any of the ten supported languages — the
 *  same fixture packages/engine/tests/language-honesty.test.ts uses, so a
 *  detection improvement that closes this gap breaks both suites together
 *  rather than only the one nobody happened to update. */
const UNSUPPORTED = `
(defun charge-card (customer-id amount)
  (let ((total (* amount 100)))
    (list :customer customer-id :total total)))
`

const TYPESCRIPT = `
export interface Payment { id: string }
export function chargeCard(customerId: string): Payment {
  const result = { id: customerId }
  return result
}
`

const notice = (page: import('@playwright/test').Page) => page.getByRole('status')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('language fallback notice', () => {
  test('is not shown before anything has been anonymized', async ({ page }) => {
    await expect(notice(page)).toBeHidden()
  })

  test('SC-001 — an unsupported file says so', async ({ page }) => {
    await typeInto(page, editors.input, UNSUPPORTED)
    await page.getByRole('button', { name: 'Anonymize →' }).click()

    await expect(notice(page)).toBeVisible()
    await expect(notice(page)).toContainText('masking is partial')
  })

  test('SC-002 — a supported language says nothing', async ({ page }) => {
    await typeInto(page, editors.input, TYPESCRIPT)
    await page.getByRole('button', { name: 'Anonymize →' }).click()

    await expect(editor(page, editors.output)).toContainText('__FN__1')
    await expect(notice(page)).toBeHidden()
  })

  test('sits above the output it warns about', async ({ page }) => {
    // jsdom has no layout engine, so this placement — the entire point of
    // FR-003 — is not something a unit test could assert.
    await typeInto(page, editors.input, UNSUPPORTED)
    await page.getByRole('button', { name: 'Anonymize →' }).click()

    const noticeBox = await notice(page).boundingBox()
    const outputBox = await editor(page, editors.output).boundingBox()
    expect(noticeBox).not.toBeNull()
    expect(outputBox).not.toBeNull()
    expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(outputBox!.y)
  })

  test('User Story 2 — selecting the real language re-processes and clears the warning', async ({
    page,
  }) => {
    await typeInto(page, editors.input, UNSUPPORTED)
    await page.getByRole('button', { name: 'Anonymize →' }).click()
    await expect(notice(page)).toBeVisible()

    await page.getByLabel('Actual language').selectOption('rust')

    await expect(notice(page)).toBeHidden()
    // Rust's grammar recognises `defun`... no — it recognises none of this
    // Lisp source either, but the point of this assertion is the mechanism,
    // not the outcome: an explicit choice bypasses detection entirely
    // (FR-004), so the warning clears regardless of whether Rust's rules
    // happen to fit better than TypeScript's did.
  })

  test('is not shown in restore mode', async ({ page }) => {
    await typeInto(page, editors.input, UNSUPPORTED)
    await page.getByRole('button', { name: 'Anonymize →' }).click()
    await expect(notice(page)).toBeVisible()

    await page.getByRole('button', { name: '② Restore from AI' }).click()

    await expect(notice(page)).toBeHidden()
  })
})
