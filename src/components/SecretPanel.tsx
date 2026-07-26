import type { SecretFinding, SecretSeverity } from '@dlgshi/engine'

// Credentials are the leak that actually costs money, so this panel sits above
// the copy action rather than below the output — it has to be read, not
// dismissed after the fact.

const SEVERITY_ORDER: SecretSeverity[] = ['critical', 'high', 'medium']

const SEVERITY_STYLE: Record<
  SecretSeverity,
  { border: string; background: string; accent: string; label: string }
> = {
  critical: {
    border: 'rgba(220, 76, 70, 0.55)',
    background: 'rgba(220, 76, 70, 0.09)',
    accent: 'var(--danger, #DC4C46)',
    label: 'Critical',
  },
  high: {
    border: 'rgba(217, 137, 104, 0.5)',
    background: 'rgba(217, 137, 104, 0.09)',
    accent: 'var(--accent, #D98968)',
    label: 'High',
  },
  medium: {
    border: 'var(--border)',
    background: 'var(--bg-elevated)',
    accent: 'var(--text-secondary)',
    label: 'Advisory',
  },
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

export default function SecretPanel({ findings }: { findings: SecretFinding[] }) {
  if (findings.length === 0) return null

  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.items.length > 0)

  const redactedCount = findings.filter((f) => f.redacted).length

  return (
    <section
      role="alert"
      aria-label="Credentials detected"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}
    >
      {grouped.map(({ severity, items }) => {
        const style = SEVERITY_STYLE[severity]
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
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  color: style.accent,
                  border: `1px solid ${style.border}`,
                  borderRadius: 20,
                  padding: '1px 8px',
                }}
              >
                {style.label}
              </span>
              <strong style={{ fontSize: 13 }}>
                {items.length} {items.length === 1 ? 'credential' : 'credentials'} detected
              </strong>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {severity === 'medium'
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
              {items.map((finding, i) => (
                <FindingRow key={`${finding.type}-${finding.line}-${i}`} finding={finding} />
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
