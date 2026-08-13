import { test, expect } from '@playwright/test'
import {
  anonymize,
  editor,
  editors,
  restoreReply,
  selectWord,
  typeInto,
  SOURCE,
} from './helpers.js'

// Covers the criteria in docs/specs/manual-masking.md that jsdom cannot reach:
// everything downstream of a real CodeMirror text selection, which needs a
// layout engine to exist at all.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('manual masking', () => {
  test('C1 — no mask action until something is selected', async ({ page }) => {
    await anonymize(page)
    await expect(page.getByRole('button', { name: 'Mask selection' })).toBeHidden()
  })

  test('C3 — masking a selected name replaces it in the output', async ({ page }) => {
    // The headline case. The engine left a surname sitting in a comment, which
    // is ROADMAP B3 — the extractor cannot see into prose.
    await anonymize(page)
    await expect(editor(page, editors.output)).toContainText('Kowalska')

    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(editor(page, editors.output)).not.toContainText('Kowalska')
    await expect(editor(page, editors.output)).toContainText('__MANUAL__1')
  })

  test('C3 — a bare account number can be masked', async ({ page }) => {
    // ROADMAP B2: not identifier-shaped, so extraction never sees it.
    await anonymize(page)
    await selectWord(page, editors.output, '88412037')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(editor(page, editors.output)).not.toContainText('88412037')
  })

  test('C5 — the mask action disappears once the selection is consumed', async ({ page }) => {
    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(page.getByRole('button', { name: 'Mask selection' })).toBeHidden()
  })

  test('automatic placeholders are left alone by a manual mark', async ({ page }) => {
    // The idempotency the whole approach rests on: re-anonymizing the output to
    // apply a mark must not renumber what is already masked.
    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(editor(page, editors.output)).toContainText('__FN__1')
    await expect(editor(page, editors.output)).toContainText('__VAR__1')
  })

  test('D1 — the marks panel appears only once something is marked', async ({ page }) => {
    await anonymize(page)
    await expect(page.getByText('Marked by hand')).toBeHidden()

    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(page.getByText('Marked by hand')).toBeVisible()
  })

  test('D2 — the panel shows the placeholder and the real term', async ({ page }) => {
    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(page.getByText('__MANUAL__1', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unmask Kowalska' })).toBeVisible()
  })

  test('D4 — unmasking puts the term back and drops the row', async ({ page }) => {
    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()
    await expect(editor(page, editors.output)).not.toContainText('Kowalska')

    await page.getByRole('button', { name: 'Unmask Kowalska' }).click()

    await expect(editor(page, editors.output)).toContainText('Kowalska')
    await expect(page.getByText('Marked by hand')).toBeHidden()
  })

  test('marks accumulate and are listed together', async ({ page }) => {
    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()
    await selectWord(page, editors.output, '88412037')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    await expect(page.getByRole('button', { name: 'Unmask Kowalska' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unmask 88412037' })).toBeVisible()
  })

  test('a manual mark survives the full round trip', async ({ page }) => {
    // The property the feature rests on: a hand-marked term restores like any
    // other placeholder, with no special handling in restore().
    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()
    await expect(editor(page, editors.output)).not.toContainText('Kowalska')

    const masked = (await editor(page, editors.output).textContent()) ?? ''
    await restoreReply(page, masked)

    await expect(editor(page, editors.restored)).toContainText('Kowalska')
  })
})

test.describe('round-trip report', () => {
  test('E2 — a clean round trip reports success', async ({ page }) => {
    await anonymize(page)
    const masked = (await editor(page, editors.output).textContent()) ?? ''
    await restoreReply(page, masked)

    await expect(page.getByText('Round trip')).toBeVisible()
    await expect(page.getByText(/came back exactly as it was sent/)).toBeVisible()
  })

  test('E3 — an invented placeholder is reported as unexplained', async ({ page }) => {
    await anonymize(page)
    await restoreReply(page, 'const x = __VAR__99')

    await expect(page.getByText(/token the map cannot explain/)).toBeVisible()
    await expect(page.getByText(/invented or altered/)).toBeVisible()
  })

  test('E4 — a renamed placeholder is reported as missing, not as an error', async ({ page }) => {
    // The silent failure this panel exists for: the model invented a readable
    // name, so the restored text looks exactly like a clean run.
    await anonymize(page)
    await restoreReply(page, 'function processInvoice(rate) { return rate }')

    await expect(page.getByText(/did not come back/)).toBeVisible()
    await expect(page.getByText(/Expected if the reply only covered part/)).toBeVisible()
  })

  test('E1 — no report panel before a restore has run', async ({ page }) => {
    await anonymize(page)
    await expect(page.getByText('Round trip')).toBeHidden()
  })
})

test.describe('restore strip options', () => {
  const REPLY = ['/** Settles the residual balance. */', 'function __FN__1() {}', '// TODO: tidy']

  test('documentation is stripped by default', async ({ page }) => {
    await anonymize(page)
    await restoreReply(page, REPLY.join('\n'))

    await expect(editor(page, editors.restored)).not.toContainText('Settles the residual')
  })

  test('Keep docs preserves JSDoc while still removing narration', async ({ page }) => {
    // The case that motivated the engine option: when a model was *asked* to
    // document its output, stripping destroys requested work rather than noise.
    await anonymize(page)
    await page.getByRole('button', { name: '② Restore from AI' }).click()
    await page.getByRole('checkbox', { name: /Keep docs/ }).check()
    await typeInto(page, editors.aiResponse, REPLY.join('\n'))
    await page.getByRole('button', { name: 'Restore →' }).click()

    await expect(editor(page, editors.restored)).toContainText('Settles the residual')
    await expect(editor(page, editors.restored)).not.toContainText('TODO')
  })

  test('the toggle is not offered in send mode', async ({ page }) => {
    await anonymize(page)
    await expect(page.getByRole('checkbox', { name: /Keep docs/ })).toBeHidden()
  })
})

test.describe('privacy surface', () => {
  test('the page makes no network request carrying the source', async ({ page }) => {
    // The core claim in the privacy notice: nothing you type leaves the machine.
    // Worth asserting rather than trusting, since it is the whole product.
    const bodies: string[] = []
    page.on('request', (r) => {
      const body = r.postData()
      if (body) bodies.push(body)
    })

    await anonymize(page)
    await selectWord(page, editors.output, 'Kowalska')
    await page.getByRole('button', { name: 'Mask selection' }).click()

    expect(bodies.join('\n')).not.toContain('Kowalska')
    expect(bodies.join('\n')).not.toContain('settleInvoice')
    expect(bodies.filter((b) => b.includes(SOURCE))).toHaveLength(0)
  })

  test('the best-effort warning is visible before any work is done', async ({ page }) => {
    await expect(page.getByText(/Always review the output before sharing/)).toBeVisible()
  })
})
