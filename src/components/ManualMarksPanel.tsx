import type { SymbolMap } from '@veilio-inc/engine'
import { MANUAL_BASE } from '@veilio-inc/engine'

interface Props {
  map: SymbolMap
  onUnmask: (placeholder: string) => void
}

/** The spans the author marked by hand.
 *
 *  Shows the real term, not a preview. It is the user's own text, on their own
 *  machine, and the whole point of the list is to check what was marked — a
 *  redacted list would be unreviewable. This is the opposite of the rule for
 *  SecretFinding, which is truncated precisely because it may be a live key.
 *
 *  Sorted by placeholder number so the order matches the reading order of the
 *  code rather than jumping around as entries are added and removed. */
export default function ManualMarksPanel({ map, onUnmask }: Props) {
  const marks = Object.entries(map)
    .filter(([placeholder]) => placeholder.startsWith(MANUAL_BASE))
    .sort(
      ([a], [b]) =>
        parseInt(a.slice(MANUAL_BASE.length), 10) - parseInt(b.slice(MANUAL_BASE.length), 10)
    )

  if (marks.length === 0) return null

  return (
    <div className="surface" style={{ overflow: 'hidden' }}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Marked by hand
        </span>
        <span className="badge badge-accent">{marks.length}</span>
      </div>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {marks.map(([placeholder, term]) => (
          <div
            key={placeholder}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--bg-elevated)',
              borderRadius: 4,
              padding: '5px 8px',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--accent)',
                flexShrink: 0,
              }}
            >
              {placeholder}
            </span>
            <span style={{ color: 'var(--text-dim)', fontSize: 11, flexShrink: 0 }}>←</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={term}
            >
              {term}
            </span>
            <button
              className="btn-ghost"
              style={{ padding: '1px 8px', fontSize: 11, flexShrink: 0 }}
              onClick={() => onUnmask(placeholder)}
              aria-label={`Unmask ${term}`}
            >
              Unmask
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
