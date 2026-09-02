// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SecretFinding, SecretSeverity, SecretType } from '@veilio-inc/engine'
import SecretPanel from './SecretPanel.js'

afterEach(cleanup)

/**
 * A panel that cries wolf trains people to dismiss it, which is worse than no
 * panel: the one finding that mattered arrives in the same grey list as ninety
 * that did not.
 */

function finding(
  type: SecretType,
  severity: SecretSeverity,
  line: number,
  label = 'Some finding'
): SecretFinding {
  return {
    type,
    severity,
    label,
    line,
    column: 1,
    length: 20,
    preview: 'abcd…wxyz',
    redacted: severity !== 'low' && severity !== 'medium',
  }
}

const AWS = finding('aws-access-key', 'critical', 40, 'AWS access key')
const emails = (n: number) =>
  Array.from({ length: n }, (_, i) => finding('email', 'low', i + 1, 'Email address'))

describe('the finding that matters is not buried', () => {
  it('renders the credential before the noise, whatever line it is on', () => {
    // The AWS key is on line 40; the emails are on lines 1-12. Source order
    // would bury it.
    const { container } = render(<SecretPanel findings={[AWS, ...emails(12)]} />)
    const text = container.textContent ?? ''
    expect(text.indexOf('AWS access key')).toBeLessThan(text.indexOf('email address'))
  })

  it('collapses a run of low-value matches to one line with a count', () => {
    render(<SecretPanel findings={[AWS, ...emails(12)]} />)
    expect(screen.getByText(/12 email address matches, not listed/i)).toBeDefined()
    // And not twelve rows.
    expect(screen.queryAllByText('abcd…wxyz').length).toBe(1)
  })

  it('lists a small number of low matches rather than summarising them', () => {
    // Collapsing two emails into "2 matches, not listed" hides information for
    // no gain — the point is the long tail, not the existence of a low finding.
    render(<SecretPanel findings={emails(2)} />)
    expect(screen.queryByText(/not listed/i)).toBeNull()
    expect(screen.queryAllByText('abcd…wxyz').length).toBe(2)
  })
})

describe('the panel only alarms when there is something to be alarmed about', () => {
  it('is an alert when a credential is present', () => {
    const { container } = render(<SecretPanel findings={[AWS, ...emails(12)]} />)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('is not an alert when everything is low', () => {
    // role="alert" interrupts a screen reader. Spending that on example email
    // addresses is the audible form of crying wolf.
    const { container } = render(<SecretPanel findings={emails(5)} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('still announces itself as something, so it is reachable', () => {
    const { container } = render(<SecretPanel findings={emails(5)} />)
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBeTruthy()
  })

  it('renders nothing at all when there are no findings', () => {
    const { container } = render(<SecretPanel findings={[]} />)
    expect(container.textContent).toBe('')
  })
})

describe('what the panel calls things', () => {
  it('does not call a low-value match a credential', () => {
    render(<SecretPanel findings={emails(2)} />)
    expect(screen.queryByText(/credentials? detected/i)).toBeNull()
  })

  it('does call a credential a credential', () => {
    render(<SecretPanel findings={[AWS]} />)
    expect(screen.getByText(/1 credential detected/i)).toBeDefined()
  })

  it('does not promise redaction for findings it left in place', () => {
    render(<SecretPanel findings={emails(2)} />)
    expect(screen.getByText(/left in place/i)).toBeDefined()
  })
})

describe('every grade the engine can emit is renderable', () => {
  it('renders a finding of each severity, dropping none', () => {
    // The panel grouped by a hardcoded list of severities. When `low` was added
    // to the engine, a low finding rendered nowhere at all — detected, reported,
    // and silently invisible.
    const all: SecretFinding[] = [
      finding('aws-access-key', 'critical', 1, 'AWS access key'),
      finding('github-token', 'high', 2, 'GitHub token'),
      finding('password-assignment', 'medium', 3, 'Password assignment'),
      finding('email', 'low', 4, 'Email address'),
    ]
    const { container } = render(<SecretPanel findings={all} />)
    for (const label of ['AWS access key', 'GitHub token', 'Password assignment', 'Email address']) {
      expect(container.textContent, `${label} not rendered`).toContain(label)
    }
  })
})
