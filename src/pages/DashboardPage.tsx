import { useState } from 'react'
import Navbar from '../components/Navbar.js'
import { useLocalMaps } from '../hooks/useLocalMaps.js'
import { exportMap } from '../lib/localCrypto.js'
import LocalKeyModal from '../components/LocalKeyModal.js'
import { LocalKeyLockedError } from '../lib/localMapStore.js'
import type { SymbolMap } from '@veilio-inc/engine'

function Toast({ msg, type }: { msg: string; type: 'success' | 'error' | '' }) {
  if (!msg) return null
  return <div className={`toast ${type}`}>{msg}</div>
}

export default function DashboardPage() {
  const { maps, deleteMap, getMap, refresh } = useLocalMaps()
  // An export waiting on the local passphrase (spec 018: contents are encrypted).
  const [pending, setPending] = useState<(() => void) | null>(null)

  /** Open a map's contents, asking for the local passphrase if needed; `then`
   *  runs once they are open. */
  async function withMap(id: string, then: (map: SymbolMap) => void | Promise<void>) {
    try {
      await then(await getMap(id))
    } catch (err) {
      if (err instanceof LocalKeyLockedError) {
        setPending(() => () => void withMap(id, then))
        return
      }
      showToast(err instanceof Error ? err.message : 'Could not open the map', 'error')
    }
  }
  const [toast, setToast] = useState({ msg: '', type: '' as 'success' | 'error' | '' })
  // Keyed by map id, not a single boolean: each row exports independently,
  // and only the row actually deriving should show busy (ROADMAP E11).
  const [derivingId, setDerivingId] = useState<string | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: '' }), 3500)
  }

  function handleExportVeilio(id: string, name: string) {
    void withMap(id, (map) => exportVeilio(id, name, map))
  }

  async function exportVeilio(id: string, name: string, map: SymbolMap) {
    const passphrase = prompt('Enter a passphrase to encrypt the export:')
    if (!passphrase) return
    setDerivingId(id)
    try {
      const json = await exportMap(map, passphrase)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name.replace(/\s+/g, '-')}.veilio`
      a.click()
      URL.revokeObjectURL(url)
      showToast('Map exported')
    } catch {
      showToast('Export failed', 'error')
    } finally {
      setDerivingId(null)
    }
  }

  function handleExportJson(id: string, name: string) {
    void withMap(id, (map) => exportJson(name, map))
  }

  function exportJson(name: string, map: SymbolMap) {
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
        <div style={{ marginBottom: 24, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 36,
                fontWeight: 400,
                letterSpacing: '-0.02em',
                marginBottom: 4,
              }}
            >
              Saved maps
            </h1>
            {maps.length > 0 && <span className="badge badge-accent">{maps.length}</span>}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
            Stored in this browser. Export as <code>.veilio</code> to back up or move between
            devices.
          </p>
        </div>

        {maps.length === 0 ? (
          <div className="empty-state">
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 44,
                height: 14,
                borderRadius: 4,
                marginBottom: 18,
                background: 'linear-gradient(135deg, var(--accent), var(--accent-hover))',
                boxShadow: '0 0 18px rgba(var(--accent-rgb), 0.4)',
              }}
            />
            <p
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 22,
                color: 'var(--text-primary)',
                marginBottom: 6,
              }}
            >
              Nothing veiled yet.
            </p>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 20 }}>
              Anonymize some code, then click &ldquo;Save map&rdquo; to keep its symbol map here.
            </p>
            <a
              href="/"
              className="btn-primary"
              style={{ display: 'inline-block', padding: '9px 20px' }}
            >
              Open the tool
            </a>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {maps.map((m) => (
              <div key={m.id} className="map-card">
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
                  <span
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: 11.5,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {m.identifierCount} identifiers · {new Date(m.savedAt).toLocaleDateString()}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                  {derivingId === m.id && (
                    <span
                      className="derive-spinner"
                      role="status"
                      aria-label="Deriving key…"
                      data-testid="derive-busy"
                    />
                  )}
                  <button
                    className="btn-ghost"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => handleExportVeilio(m.id, m.name)}
                    disabled={derivingId !== null}
                  >
                    .veilio
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

      {pending && (
        <LocalKeyModal
          onUnlocked={() => {
            const run = pending
            setPending(null)
            run()
          }}
          onForgotten={() => {
            setPending(null)
            refresh()
          }}
          onClose={() => setPending(null)}
        />
      )}

      <Toast msg={toast.msg} type={toast.type} />
    </div>
  )
}
