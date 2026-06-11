import type { SymbolMap } from '@dlgshi/engine'

interface Props {
  map: SymbolMap
  onClose: () => void
}

export default function MapOverlay({ map, onClose }: Props) {
  const entries = Object.entries(map)

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        style={{ maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 400 }}>
              Symbol map
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              {entries.length} identifiers
            </p>
          </div>
          <button className="btn-ghost" style={{ padding: '5px 12px' }} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    fontWeight: 400,
                  }}
                >
                  Placeholder
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    fontWeight: 400,
                  }}
                >
                  Real name
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([placeholder, realName]) => (
                <tr key={placeholder} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td
                    style={{
                      padding: '7px 8px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--accent)',
                    }}
                  >
                    {placeholder}
                  </td>
                  <td
                    style={{
                      padding: '7px 8px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--code-text)',
                    }}
                  >
                    {realName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <p style={{ color: 'var(--text-dim)', textAlign: 'center', padding: 24, fontSize: 13 }}>
              No identifiers yet. Anonymize some code first.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
