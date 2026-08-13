// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ScrubPage from './ScrubPage.js'

// CodeMirror measures itself on every render and jsdom has no layout engine, so
// it throws from getClientRects. The editor still mounts and is queryable; these
// stubs only stop it flooding stderr. Anything that genuinely depends on layout
// — chiefly making a real text selection — is not testable here, which is why
// the mark/unmark transforms live in lib/manualMarks and are tested directly.
beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

afterEach(() => {
  cleanup()
  // Not guaranteed to exist depending on how the jsdom env is provisioned, and
  // a teardown that throws would fail tests that already passed.
  globalThis.localStorage?.clear()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <ScrubPage />
    </MemoryRouter>
  )
}

describe('ScrubPage', () => {
  it('offers no mask action when nothing is selected', () => {
    // C1 — the button is selection-gated, not always present.
    renderPage()
    expect(screen.queryByRole('button', { name: 'Mask selection' })).toBeNull()
  })

  it('offers no mask action in restore mode', async () => {
    // C2 — restore output holds real names; masking there is meaningless.
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /Restore/ }))

    expect(screen.queryByRole('button', { name: 'Mask selection' })).toBeNull()
  })

  it('shows no marks panel before anything is marked', () => {
    // D1 at page level.
    renderPage()
    expect(screen.queryByText('Marked by hand')).toBeNull()
  })

  it('shows no round-trip panel before a restore has run', () => {
    // E1 at page level — the panel must not appear on first load.
    renderPage()
    expect(screen.queryByText('Round trip')).toBeNull()
  })

  it('starts in send mode with the anonymize action', () => {
    renderPage()
    expect(screen.getByRole('button', { name: /Anonymize/ })).toBeTruthy()
  })

  it('keeps the best-effort warning visible', () => {
    // The disclaimer terms.md and the AUP both rely on: users are told the
    // output needs review before it is shared.
    renderPage()
    expect(screen.getByText(/Always review the output before sharing/)).toBeTruthy()
  })

  it('disables the primary action while the input is empty', () => {
    renderPage()
    const btn = screen.getByRole('button', { name: /Anonymize/ })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})
