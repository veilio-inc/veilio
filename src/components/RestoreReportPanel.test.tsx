// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { RestoreReport } from '@veilio-inc/engine'
import RestoreReportPanel from './RestoreReportPanel.js'

afterEach(cleanup)

const report = (over: Partial<RestoreReport> = {}): RestoreReport => ({
  resolved: [],
  missing: [],
  unresolved: [],
  ...over,
})

describe('RestoreReportPanel', () => {
  it('renders nothing when there was nothing to restore and nothing is wrong', () => {
    // E1 — restoring plain text with an empty map is not a result worth a panel.
    const { container } = render(<RestoreReportPanel report={report()} />)
    expect(container.innerHTML).toBe('')
  })

  it('reads as success when every placeholder came back', () => {
    // E2
    render(<RestoreReportPanel report={report({ resolved: ['__FN__1', '__VAR__1'] })} />)

    expect(screen.getByText('2 / 2 restored')).toBeTruthy()
    expect(screen.getByText(/came back exactly as it was sent/)).toBeTruthy()
  })

  it('surfaces unresolved tokens as a problem', () => {
    // E3 — always wrong: the text carries a token that means nothing.
    render(
      <RestoreReportPanel report={report({ resolved: ['__FN__1'], unresolved: ['__VAR__9'] })} />
    )

    expect(screen.getByText(/1 token the map cannot explain/)).toBeTruthy()
    expect(screen.getByText('__VAR__9')).toBeTruthy()
    expect(screen.getByText(/invented or altered/)).toBeTruthy()
  })

  it('frames missing placeholders as information, not failure', () => {
    // E4 — a model answering about one function legitimately omits the rest.
    render(<RestoreReportPanel report={report({ resolved: ['__FN__1'], missing: ['__VAR__3'] })} />)

    expect(screen.getByText(/1 placeholder did not come back/)).toBeTruthy()
    expect(screen.getByText(/Expected if the reply only covered part/)).toBeTruthy()
  })

  it('counts resolved over total, excluding unresolved from the denominator', () => {
    // E5 — unresolved tokens were never ours to restore, so they must not
    // inflate the total and make a clean run look incomplete.
    render(
      <RestoreReportPanel
        report={report({ resolved: ['__FN__1'], missing: ['__VAR__1'], unresolved: ['__CLS__9'] })}
      />
    )

    expect(screen.getByText('1 / 2 restored')).toBeTruthy()
  })

  it('pluralises both section headings', () => {
    render(
      <RestoreReportPanel
        report={report({ missing: ['__VAR__1', '__VAR__2'], unresolved: ['__A__1', '__B__2'] })}
      />
    )

    expect(screen.getByText(/2 tokens the map cannot explain/)).toBeTruthy()
    expect(screen.getByText(/2 placeholders did not come back/)).toBeTruthy()
  })

  it('truncates a long token list with an overflow indicator', () => {
    // E6
    const many = Array.from({ length: 15 }, (_, i) => `__VAR__${i + 1}`)
    render(<RestoreReportPanel report={report({ missing: many })} />)

    expect(screen.getByText('+3 more')).toBeTruthy()
    expect(screen.queryByText('__VAR__13')).toBeNull()
  })

  it('shows the unresolved section even when no map entries existed', () => {
    // Restoring a reply with a stale map: nothing to resolve, but the invented
    // token still has to be reported.
    render(<RestoreReportPanel report={report({ unresolved: ['__FN__4'] })} />)

    expect(screen.getByText('__FN__4')).toBeTruthy()
    expect(screen.getByText('0 / 0 restored')).toBeTruthy()
  })
})
