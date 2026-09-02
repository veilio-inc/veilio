import { test, expect } from '@playwright/test'
import { anonymize, editor, editors, selectWord, typeInto } from './helpers.js'

// 004-b3, User Story 1. The engine leaves comment prose unmasked on purpose, so
// the whole feature is a sentence on a screen — and where that sentence sits is
// the feature. A warning rendered below the output is read after the copy, and
// a warning read after the copy is a post-mortem.
//
// jsdom cannot answer that. It has no layout engine, so "above the thing it
// warns about" is not a question it can be asked. Everything here needs a real
// browser for exactly that reason.

/** A comment above the code and a comment beside it — the two positions the
 *  grading distinguishes, in the shape they actually turn up in. */
const SOURCE = `// Copyright 2026 Veilio
function retryPolicy(attempts) {
  // Workaround for the Contoso Health outage on the 14th — see INC-4471.
  return ledgerService.retry(attempts)
}`

const NO_COMMENTS = `function retryPolicy(attempts) {
  return ledgerService.retry(attempts)
}`

/** The inline comment here is a single word, so one mark empties it. That is
 *  the shape that makes the effect of marking visible end to end: a comment
 *  holding nothing but a placeholder is no longer prose leaving unmasked, and
 *  the notice has to stop counting it. */
const MARKABLE = `// Copyright 2026 Veilio
function retryPolicy(attempts) {
  // Contoso
  return ledgerService.retry(attempts)
}`

const notice = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Comment prose' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('comment exposure notice', () => {
  test('is not shown before anything has been anonymized', async ({ page }) => {
    await expect(notice(page)).toBeHidden()
  })

  test('SC-001 — a file with comments says so, with a count', async ({ page }) => {
    await anonymize(page, SOURCE)
    await expect(notice(page)).toBeVisible()
    await expect(notice(page)).toContainText('2 comments, 1 inside the body')
    await expect(notice(page)).toContainText('comment text is never masked')
  })

  test('SC-002 — a file without comments says nothing', async ({ page }) => {
    await anonymize(page, NO_COMMENTS)
    await expect(editor(page, editors.output)).toContainText('__FN__1')
    await expect(notice(page)).toBeHidden()
  })

  test('names the action that closes the leak', async ({ page }) => {
    // Acceptance scenario 3. Not merely "there is a risk" — the control has a
    // label, and the notice uses it.
    await anonymize(page, SOURCE)
    await expect(notice(page)).toContainText('Mask selection')
  })

  test('sits above the output it warns about', async ({ page }) => {
    // The whole point of the placement, and the only assertion here that a unit
    // test could not have made. A notice below the anonymized panel is read
    // after the paste it was meant to prevent.
    await anonymize(page, SOURCE)
    const noticeBox = await notice(page).boundingBox()
    const outputBox = await editor(page, editors.output).boundingBox()
    expect(noticeBox).not.toBeNull()
    expect(outputBox).not.toBeNull()
    expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(outputBox!.y)
  })

  test('US1 and US2 meet: marking prose in a comment moves the notice', async ({ page }) => {
    // The obligation Story 1 creates has to be dischargeable, and visibly so. A
    // warning that reads identically after the user acts on it teaches that
    // acting on it is pointless — so this asserts the text CHANGES, not merely
    // that the panel is still on screen.
    await anonymize(page, MARKABLE)
    await expect(notice(page)).toContainText('2 comments, 1 inside the body')

    await selectWord(page, editors.output, 'Contoso')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    // That comment now holds a placeholder and nothing else, so there is no
    // prose left in it to leak — and with nothing left beside the code, the
    // grade drops to the quiet one.
    await expect(editor(page, editors.output)).not.toContainText('Contoso')
    await expect(notice(page)).toContainText('1 comment above the code')
  })

  test('is not shown in restore mode', async ({ page }) => {
    // It describes the anonymize pass. Left standing next to restored code it
    // would be describing the previous document.
    await anonymize(page, SOURCE)
    await expect(notice(page)).toBeVisible()

    await page.getByRole('button', { name: '② Restore from AI' }).click()
    await typeInto(page, editors.aiResponse, 'function __FN__1() {}')
    await page.getByRole('button', { name: 'Restore →' }).click()

    await expect(notice(page)).toBeHidden()
  })
})
