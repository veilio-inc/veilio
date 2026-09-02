// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { anonymize } from '@veilio-inc/engine'
import type { CommentExposure } from '@veilio-inc/engine'
import CommentNotice from './CommentNotice.js'

afterEach(cleanup)

/**
 * 004-b3, User Story 1. The engine leaves comment prose alone on purpose, and
 * the anonymized panel gives no sign of it — the output looks handled. This
 * panel is the whole of the fix: it does not close the leak, it makes the leak
 * a decision somebody actually took.
 *
 * Which is why the copy matters as much as the count. A user who is told there
 * is a risk and not told what to do about it closes the panel the same way they
 * would close nothing at all.
 */

/** Drive the notice from real engine output rather than a hand-written object,
 *  so a change in what the engine measures shows up here instead of quietly
 *  agreeing with a fixture. */
function exposureOf(source: string): CommentExposure {
  return anonymize(source).comments
}

describe('CommentNotice', () => {
  it('renders nothing when no comment prose left', () => {
    // FR-003. A panel on every paste regardless of content is furniture.
    const { container } = render(
      <CommentNotice exposure={exposureOf('const orderTotal = settleInvoice(cart)')} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('states that comment text is not masked', () => {
    render(<CommentNotice exposure={exposureOf('const a = 1 // ping Maria about Contoso')} />)
    expect(screen.getByText(/never masked/i)).toBeTruthy()
  })

  it('says how many comments are affected', () => {
    const source = [
      'const a = one() // first note about the account',
      'const b = two() // second note about the account',
    ].join('\n')
    render(<CommentNotice exposure={exposureOf(source)} />)
    expect(screen.getByText(/2 comments/)).toBeTruthy()
  })

  it('uses the singular for a single comment', () => {
    // Small, and it is the difference between a panel that was written and one
    // that was generated. A reader who spots "1 comments" stops trusting the
    // rest of the number.
    render(<CommentNotice exposure={exposureOf('const a = 1 // one note here')} />)
    expect(screen.getByText(/1 comment left as written/)).toBeTruthy()
  })

  it('names both ways to close the leak', () => {
    // Acceptance scenario 3. Mark the span, or drop the comment. Naming the
    // control by the label it actually wears — "Mask selection" — is the
    // difference between an instruction and a gesture at one.
    render(<CommentNotice exposure={exposureOf('const a = 1 // ping Maria about Contoso')} />)
    const body = screen.getByText(/Names, customers and ticket numbers/)
    expect(body.textContent).toMatch(/Mask selection/)
    expect(body.textContent).toMatch(/delete the comment/i)
  })

  it('says where the comments are when only some sit beside code', () => {
    const source = ['// Copyright 2026 Veilio', 'const a = one() // note about Contoso'].join('\n')
    render(<CommentNotice exposure={exposureOf(source)} />)
    expect(screen.getByText(/2 comments, 1 of them beside code/)).toBeTruthy()
  })

  it('says a licence header is above the code, and grades it quietly', () => {
    // Edge case from the spec: a header is in nearly every file and is almost
    // never sensitive. Same weight as an incident note is how this panel becomes
    // the next thing users learn to ignore.
    const source = ['// Copyright 2026 Veilio', '// See LICENSE.', 'const a = one()'].join('\n')
    render(<CommentNotice exposure={exposureOf(source)} />)
    expect(screen.getByText(/1 comment above the code/)).toBeTruthy()
    expect(screen.getByText('Noted')).toBeTruthy()
  })

  it('grades a comment beside code as advisory', () => {
    render(<CommentNotice exposure={exposureOf('const a = 1 // ping Maria about Contoso')} />)
    expect(screen.getByText('Advisory')).toBeTruthy()
  })

  it('never interrupts a screen reader', () => {
    // FR-007, and the reason this is not a SecretPanel group. Nearly every real
    // file has a comment beside code, so `role="alert"` here would fire on
    // almost every paste — spending, on wallpaper, the interruption the actual
    // credential warning needs.
    const { container } = render(
      <CommentNotice exposure={exposureOf('const a = 1 // ping Maria about Contoso')} />
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(screen.getByLabelText('Comment prose')).toBeTruthy()
  })

  it('does not quantify prose too small to be worth a number', () => {
    render(<CommentNotice exposure={exposureOf('const a = 1 // a note')} />)
    expect(screen.queryByText(/characters of prose/)).toBeNull()
  })

  it('quantifies prose once there is enough of it to matter', () => {
    const source = `const a = 1 // ${'an unmasked sentence about the Contoso Health account. '.repeat(6)}`
    render(<CommentNotice exposure={exposureOf(source)} />)
    expect(screen.getByText(/characters of prose/)).toBeTruthy()
  })

  it('says nothing about a comment already reduced to placeholders', () => {
    // US1 and US2 have to agree: once the prose is marked, there is nothing
    // left in that comment to warn about, and the warning has to go.
    const { container } = render(
      <CommentNotice
        exposure={anonymize('const a = 1 // Contoso', { manual: ['Contoso'] }).comments}
      />
    )
    expect(container.innerHTML).toBe('')
  })
})
