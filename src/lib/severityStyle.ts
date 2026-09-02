import type { SecretSeverity } from '@veilio-inc/engine'

/** The one grading scale the page speaks.
 *
 *  Lives here rather than inside the credential panel because it is no longer
 *  only about credentials: 004-b3 grades comment exposure on the same four
 *  steps. A second table, however carefully copied, is how "Advisory" ends up
 *  meaning two different things on the same screen — and the scale stops being
 *  a scale the moment a reader has to learn which panel they are looking at
 *  before they can read the badge.
 *
 *  Low is deliberately the quietest thing on the page: no tint, no accent. Those
 *  findings are usually benign, and giving them the weight of a credential is
 *  what trained people to skim past the one that mattered. */
export interface SeverityStyle {
  border: string
  background: string
  accent: string
  label: string
}

export const SEVERITY_STYLE: Record<SecretSeverity, SeverityStyle> = {
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
  low: {
    border: 'var(--border)',
    background: 'transparent',
    accent: 'var(--text-dim)',
    label: 'Noted',
  },
}

/** The badge every graded panel wears, so the four steps look the same
 *  wherever they appear. */
export function severityBadgeStyle(severity: SecretSeverity): React.CSSProperties {
  const style = SEVERITY_STYLE[severity]
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontWeight: 700,
    color: style.accent,
    border: `1px solid ${style.border}`,
    borderRadius: 20,
    padding: '1px 8px',
  }
}
