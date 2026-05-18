import { useState } from 'react'
import Navbar from '../components/Navbar.js'
import { useLocalMaps } from '../hooks/useLocalMaps.js'
import { exportMap } from '../lib/localCrypto.js'

function Toast({ msg, type }: { msg: string; type: 'success' | 'error' | '' }) {
  if (!msg) return null
  return <div className={`toast ${type}`}>{msg}</div>
}

export default function DashboardPage() {
  const { maps, deleteMap } = useLocalMaps()
  const [toast, setToast] = useState({ msg: '', type: '' as 'success' | 'error' | '' })

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: '' }), 3500)
  }

  async function handleExportScrubr(id: string, name: string) {
    const map = maps.find((m) => m.id === id)?.map
    if (!map) return
    const passphrase = prompt('Enter a passphrase to encrypt the export:')
    if (!passphrase) return
    try {
      const json = await exportMap(map, passphrase)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name.replace(/\s+/g, '-')}.scrubr`
      a.click()
      URL.revokeObjectURL(url)
      showToast('Map exported')
    } catch {
      showToast('Export failed', 'error')
    }
  }

  function handleExportJson(id: string, name: string) {
    const map = maps.find((m) => m.id === id)?.map
    if (!map) return
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/\s+/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this map? This cannot be undone.')) return
    deleteMap(id)
    showToast('Map deleted')
  }

  return (
    <div className="page">
      <Navbar />

      <div style={{ padding: '24px', maxWidth: 800, margin: '0 auto', width: '100%' }}>
        <div style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              marginBottom: 4,
            }}
          >
            Saved maps
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
            Stored in this browser. Export as <code>.scrubr</code> to back up or move between devices.
          </p>
        </div>

        {maps.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0' }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>No maps saved yet.</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              Anonymize some code on the{' '}
              <a href="/" style={{ color: 'var(--accent)' }}>
                main page
              </a>{' '}
              and click "Save map".
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {maps.map((m) => (
              <div
                key={m.id}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {m.name}
                  </span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                    {m.identifierCount} identifiers ·{' '}
                    {new Date(m.savedAt).toLocaleDateString()}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn-ghost"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => handleExportScrubr(m.id, m.name)}
                  >
                    .scrubr
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => handleExportJson(m.id, m.name)}
                  >
                    .json
                  </button>
                  <button
                    className="btn-danger"
                    style={{ fontSize: 12 }}
                    onClick={() => handleDelete(m.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Toast msg={toast.msg} type={toast.type} />
    </div>
  )
}
