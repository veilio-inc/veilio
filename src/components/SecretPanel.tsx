import type { SecretFinding, SecretSeverity } from '@veilio-inc/engine'
import { SEVERITY_STYLE, severityBadgeStyle } from '../lib/severityStyle.js'

// Credentials are the leak that actually costs money, so this panel sits above
// the copy action rather than below the output — it has to be read, not
// dismissed after the fact.

const SEVERITY_ORDER: SecretSeverity[] = ['critical', 'high', 'medium', 'low']

/** More than this many findings of one LOW type collapse to a summary row.
 *  Twelve example addresses listed individually is what teaches a reader that
 *  this panel is noise; a single line saying "12 email addresses" does not. */
const COLLAPSE_AFTER = 3

/** What a group of this grade actually contains. Calling an email address a
 *  "credential" is the same overstatement as colouring it red. */
const GROUP_NOUN: Record<SecretSeverity, [singular: string, plural: string]> = {
  critical: ['credential', 'credentials'],
  high: ['credential', 'credentials'],
  medium: ['possible credential', 'possible credentials'],
  low: ['other match', 'other matches'],
}

function FindingRow({ finding }: { finding: SecretFinding }) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 13,
        lineHeight: 1.6,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontWeight: 600 }}>{finding.label}</span>
      <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        line {finding.line}
      </span>
      <code
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          background: 'var(--bg-surface)',
          borderRadius: 4,
          padding: '1px 6px',
        }}
      >
        {finding.preview}
      </code>
    </li>
  )
}

/**
 * Collapse runs of the same low-value type into one row.
 *
 * Returns the rows to render plus the summaries that stand in for what was
 * hidden. Only LOW is ever collapsed: a repeated credential is not noise, it is
 * a worse leak.
 */
function collapseLow(
  items: SecretFinding[],
  severity: SecretSeverity
): { rows: SecretFinding[]; summaries: { label: string; count: number }[] } {
  if (severity !== 'low') return { rows: items, summaries: [] }

  const byType = new Map<string, SecretFinding[]>()
  for (const f of items) byType.set(f.type, [...(byType.get(f.type) ?? []), f])

  const rows: SecretFinding[] = []
  const summaries: { label: string; count: number }[] = []
  for (const group of byType.values()) {
    if (group.length > COLLAPSE_AFTER) {
      summaries.push({ label: group[0].label, count: group.length })
    } else {
      rows.push(...group)
    }
  }
  return { rows, summaries }
}

export default function SecretPanel({ findings }: { findings: SecretFinding[] }) {
  if (findings.length === 0) return null

  // FR-004. `role="alert"` interrupts a screen reader; spending that on a list
  // of example email addresses is the audible version of crying wolf, and it
  // spends the interruption that the real warning needs.
  const isAlert = findings.some((f) => f.severity !== 'low')

  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.items.length > 0)

  const redactedCount = findings.filter((f) => f.redacted).length

  return (
    <section
      {...(isAlert ? { role: 'alert' } : {})}
      aria-label={isAlert ? 'Credentials detected' : 'Scan notes'}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}
    >
      {grouped.map(({ severity, items }) => {
        const style = SEVERITY_STYLE[severity]
        const { rows, summaries } = collapseLow(items, severity)
        const [singular, plural] = GROUP_NOUN[severity]
        return (
          <div
            key={severity}
            style={{
              border: `1px solid ${style.border}`,
              background: style.background,
              borderRadius: 8,
              padding: '12px 16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={severityBadgeStyle(severity)}>{style.label}</span>
              <strong style={{ fontSize: 13 }}>
                {items.length} {items.length === 1 ? singular : plural} detected
              </strong>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {severity === 'low' || severity === 'medium'
                  ? '— left in place; review before sharing.'
                  : '— redacted, and not recoverable on restore.'}
              </span>
            </div>
            <ul
              style={{
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                margin: 0,
                padding: 0,
              }}
            >
              {rows.map((finding, i) => (
                <FindingRow key={`${finding.type}-${finding.line}-${i}`} finding={finding} />
              ))}
              {summaries.map((s) => (
                <li
                  key={s.label}
                  style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}
                >
                  {s.count} {s.label.toLowerCase()} matches, not listed
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      {redactedCount > 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
          Redacted values were replaced with <code>__REDACTED_*__</code> and never written to your
          symbol map — restoring will not bring them back. Rotate anything that was real.
        </p>
      )}
    </section>
  )
}
