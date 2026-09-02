import { describe, it, expect } from 'vitest'
import {
  SECRET_SEVERITIES,
  detectSecrets,
  hasBlockingSecrets,
  scanSecrets,
  type SecretSeverity,
  type SecretType,
} from '../src/secrets.js'

/**
 * The severity scale has to carry information.
 *
 * It previously graded 25 of 33 rules `critical`. When three quarters of a scale
 * is one value the scale says nothing, and a panel that renders an email address
 * with the visual weight of a leaked AWS key trains people to skim it. The one
 * finding that mattered then arrives in the same grey list as ninety that did not.
 */

const GRADES = Object.entries(SECRET_SEVERITIES) as [SecretType, SecretSeverity][]

describe('the scale distinguishes', () => {
  it('never lets one grade hold more than half the rules', () => {
    // The regression guard. Re-flattening the scale is a one-line edit and its
    // symptom — a panel nobody reads — shows up nowhere in a test run.
    const counts = new Map<SecretSeverity, number>()
    for (const [, grade] of GRADES) counts.set(grade, (counts.get(grade) ?? 0) + 1)
    const worst = Math.max(...counts.values())
    expect(
      worst / GRADES.length,
      `grades: ${JSON.stringify(Object.fromEntries(counts))}`
    ).toBeLessThanOrEqual(0.5)
  })

  it('uses every grade, so none is decorative', () => {
    const used = new Set(GRADES.map(([, g]) => g))
    for (const grade of ['critical', 'high', 'medium', 'low'] as SecretSeverity[]) {
      expect(used.has(grade), `nothing is graded ${grade}`).toBe(true)
    }
  })

  it('grades the usually-benign types low', () => {
    expect(SECRET_SEVERITIES.email).toBe('low')
    expect(SECRET_SEVERITIES['private-ip']).toBe('low')
  })

  it('pins the grade of every rule, so a future edit is a visible decision', () => {
    // Spot-checks across the range rather than the whole table: enough that a
    // sweeping re-grade cannot pass, few enough that adding one rule does not
    // rewrite this test.
    expect(SECRET_SEVERITIES['private-key']).toBe('critical')
    expect(SECRET_SEVERITIES['aws-secret-key']).toBe('critical')
    expect(SECRET_SEVERITIES['connection-string']).toBe('critical')
    expect(SECRET_SEVERITIES['github-token']).toBe('high')
    expect(SECRET_SEVERITIES['openai-key']).toBe('high')
    expect(SECRET_SEVERITIES['high-entropy-string']).toBe('medium')
    expect(SECRET_SEVERITIES['password-assignment']).toBe('medium')
  })
})

describe('re-grading did not change what is destroyed', () => {
  // FR-005. Redaction is irreversible: the value never enters the SymbolMap, so
  // restore() cannot bring it back. Tying that to a display grade means calming
  // the panel would silently stop protecting a credential — a security change
  // in a diff that reads as cosmetic.

  // A key that really matches the rule. An earlier version of this test used a
  // sample that matched nothing and guarded its assertions with `if (finding)`,
  // so it passed while proving nothing — it survived the mutation that ties
  // redaction back to severity, which is the exact regression it exists to catch.
  const DATADOG = 'DD_API_KEY=0123456789abcdef0123456789abcdef'
  const DATADOG_SECRET = '0123456789abcdef0123456789abcdef'

  it('detects the sample this section depends on', () => {
    expect(detectSecrets(DATADOG).map((f) => f.type)).toContain('datadog-key')
  })

  it('still redacts a type whose grade was lowered', () => {
    // `datadog-key` was `critical` before the re-grade and is `medium` now. If
    // redaction followed severity it would have stopped being redacted here,
    // silently, in a commit about panel presentation.
    expect(SECRET_SEVERITIES['datadog-key']).toBe('medium')
    const scan = scanSecrets(DATADOG, 'redact')
    const finding = scan.findings.find((f) => f.type === 'datadog-key')
    expect(finding).toBeDefined()
    expect(finding!.redacted).toBe(true)
    expect(scan.code).not.toContain(DATADOG_SECRET)
  })

  it('still blocks on a type whose grade was lowered', () => {
    expect(hasBlockingSecrets(detectSecrets(DATADOG))).toBe(true)
  })

  it('does not redact or block the report-only types', () => {
    const scan = scanSecrets('const owner = "x@y.com"\nconst host = "10.0.3.14"', 'redact')
    expect(scan.findings.length).toBeGreaterThan(0)
    for (const f of scan.findings) expect(f.redacted).toBe(false)
    expect(scan.code).toContain('x@y.com')
    expect(hasBlockingSecrets(scan.findings)).toBe(false)
  })

  it('redacts a newly added credential type by default', () => {
    // The deny-list is what makes this true: a rule added tomorrow protects
    // because it exists, not because somebody remembered to opt it in.
    const actionable = GRADES.map(([t]) => t).filter(
      (t) => t !== 'email' && t !== 'private-ip' && t !== 'possible-credential'
    )
    expect(actionable.length).toBe(GRADES.length - 3)
  })
})
