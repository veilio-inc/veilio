// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ManualMarksPanel from './ManualMarksPanel.js'

afterEach(cleanup)

describe('ManualMarksPanel', () => {
  it('renders nothing when there are no manual marks', () => {
    // D1
    const { container } = render(<ManualMarksPanel map={{}} onUnmask={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the map holds only automatic placeholders', () => {
    // D6 — a map full of __FN__/__VAR__ entries is the common case and must not
    // produce an empty panel with a "0" badge.
    const { container } = render(
      <ManualMarksPanel map={{ __FN__1: 'settle', __VAR__1: 'rate' }} onUnmask={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('shows each mark with its placeholder and its real term', () => {
    // D2 — the term is shown in full on purpose: it is the user's own text on
    // their own machine, and a redacted list would be unreviewable.
    render(<ManualMarksPanel map={{ __MANUAL__1: 'Kowalska' }} onUnmask={vi.fn()} />)

    expect(screen.getByText('__MANUAL__1')).toBeTruthy()
    expect(screen.getByText('Kowalska')).toBeTruthy()
  })

  it('lists only manual entries when the map is mixed', () => {
    // D6
    render(
      <ManualMarksPanel
        map={{ __FN__1: 'settle', __MANUAL__1: 'Kowalska', __VAR__1: 'rate' }}
        onUnmask={vi.fn()}
      />
    )

    expect(screen.getByText('Kowalska')).toBeTruthy()
    expect(screen.queryByText('settle')).toBeNull()
    expect(screen.queryByText('rate')).toBeNull()
  })

  it('orders marks numerically, not by string comparison', () => {
    // D3 — the regression this guards: sorting placeholder keys as strings puts
    // __MANUAL__10 before __MANUAL__2.
    render(
      <ManualMarksPanel
        map={{ __MANUAL__10: 'tenth', __MANUAL__2: 'second', __MANUAL__1: 'first' }}
        onUnmask={vi.fn()}
      />
    )

    const buttons = screen.getAllByRole('button', { name: /^Unmask / })
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Unmask first',
      'Unmask second',
      'Unmask tenth',
    ])
  })

  it('calls onUnmask with the placeholder that was clicked', () => {
    // D4
    const onUnmask = vi.fn()
    render(
      <ManualMarksPanel
        map={{ __MANUAL__1: 'Kowalska', __MANUAL__2: '88412037' }}
        onUnmask={onUnmask}
      />
    )

    screen.getByRole('button', { name: 'Unmask 88412037' }).click()
    expect(onUnmask).toHaveBeenCalledTimes(1)
    expect(onUnmask).toHaveBeenCalledWith('__MANUAL__2')
  })

  it('gives every unmask control a distinguishable accessible name', async () => {
    // D7 — four buttons all reading "Unmask" is unusable on a screen reader.
    render(
      <ManualMarksPanel
        map={{ __MANUAL__1: 'Kowalska', __MANUAL__2: '88412037' }}
        onUnmask={vi.fn()}
      />
    )

    const names = screen
      .getAllByRole('button', { name: /^Unmask / })
      .map((b) => b.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(names.length)

    // Reachable by keyboard, not mouse-only.
    await userEvent.tab()
    expect(document.activeElement?.tagName).toBe('BUTTON')
  })

  it('counts the marks in the header badge', () => {
    render(
      <ManualMarksPanel
        map={{ __MANUAL__1: 'a', __MANUAL__2: 'b', __FN__1: 'ignored' }}
        onUnmask={vi.fn()}
      />
    )

    const header = screen.getByText('Marked by hand').parentElement!
    expect(within(header).getByText('2')).toBeTruthy()
  })

  it('keeps a long term available in full via its title attribute', () => {
    // The row ellipsises for layout; the whole value must stay reachable.
    const term = 'a-very-long-internal-service-identifier-that-will-not-fit-on-one-line'
    render(<ManualMarksPanel map={{ __MANUAL__1: term }} onUnmask={vi.fn()} />)

    expect(screen.getByTitle(term)).toBeTruthy()
  })
})
