import type { StrippedItem, StrippedItemType } from '@veilio/shared'

const TYPE_LABELS: Record<StrippedItemType, string> = {
  jsdoc: 'JSDoc block',
  todo: 'TODO / FIXME',
  'step-marker': 'Step marker',
  narration: 'Action narration',
  separator: 'Separator',
  'section-header': 'Section header',
  'inline-annotation': 'Inline annotation',
}

const TYPE_COLORS: Record<StrippedItemType, string> = {
  jsdoc: '#a78bfa',
  todo: '#f97316',
  'step-marker': '#60a5fa',
  narration: '#34d399',
  separator: '#888888',
  'section-header': '#fbbf24',
  'inline-annotation': '#f472b6',
}

interface Props {
  items: StrippedItem[]
}

export default function StrippedPanel({ items }: Props) {
  if (items.length === 0) return null

  const byType = items.reduce<Partial<Record<StrippedItemType, StrippedItem[]>>>((acc, item) => {
    acc[item.type] = acc[item.type] ?? []
    acc[item.type]!.push(item)
    return acc
  }, {})

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
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
          Stripped AI metadata
        </span>
        <span className="badge badge-accent">{items.length}</span>
      </div>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(Object.entries(byType) as [StrippedItemType, StrippedItem[]][]).map(
          ([type, typeItems]) => (
            <div key={type}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: TYPE_COLORS[type],
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {TYPE_LABELS[type]}{' '}
                  <span style={{ color: 'var(--text-dim)' }}>× {typeItems.length}</span>
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 16 }}>
                {typeItems.slice(0, 3).map((item, i) => (
                  <div
                    key={i}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--text-dim)',
                      background: 'var(--bg-elevated)',
                      padding: '4px 8px',
                      borderRadius: 4,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}
                  >
                    <span style={{ color: 'var(--text-secondary)', marginRight: 6 }}>
                      L{item.lineNumber}
                    </span>
                    {item.content.slice(0, 80)}
                    {item.content.length > 80 ? '…' : ''}
                  </div>
                ))}
                {typeItems.length > 3 && (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', paddingLeft: 4 }}>
                    +{typeItems.length - 3} more
                  </span>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}
