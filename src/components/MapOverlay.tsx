import type { SymbolMap } from '@veilio-inc/engine'

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
        style={{ maxWidth: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
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
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {entries.length} identifiers veiled
            </p>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, borderRadius: 8 }}>
          <table className="map-table">
            <thead>
              <tr>
                <th>Placeholder</th>
                <th aria-hidden style={{ width: 28 }} />
                <th>Real name</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([placeholder, realName]) => (
                <tr key={placeholder}>
                  <td style={{ color: 'var(--accent-bright)' }}>{placeholder}</td>
                  <td aria-hidden style={{ color: 'var(--text-dim)', textAlign: 'center' }}>
                    →
                  </td>
                  <td style={{ color: 'var(--code-text)' }}>{realName}</td>
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
