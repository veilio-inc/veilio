import { useState } from 'react'
import type { SymbolMap } from '@veilio-inc/engine'
import { useLocalMaps } from '../hooks/useLocalMaps.js'
import LocalKeyModal from './LocalKeyModal.js'
import { LocalKeyLockedError } from '../lib/localMapStore.js'

interface Props {
  map: SymbolMap
  onClose: () => void
  onSaved?: (name: string) => void
}

export default function SaveMapModal({ map, onClose, onSaved }: Props) {
  const { saveMap } = useLocalMaps()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Local maps are encrypted with the local passphrase (spec 018).
  const [needKey, setNeedKey] = useState(false)

  async function persist() {
    setSaving(true)
    setError('')
    try {
      await saveMap(name.trim(), map)
      onSaved?.(name.trim())
      onClose()
    } catch (err) {
      if (err instanceof LocalKeyLockedError) {
        setNeedKey(true)
        return
      }
      setError(err instanceof Error ? err.message : 'Could not save the map')
    } finally {
      setSaving(false)
    }
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    void persist()
  }

  if (needKey) {
    return (
      <LocalKeyModal
        onUnlocked={() => {
          setNeedKey(false)
          void persist()
        }}
        onClose={() => setNeedKey(false)}
      />
    )
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {/* Same mark as the nav and the footer. This was the other place the
            old gradient bar survived. */}
        <img
          src="/icon.svg"
          alt=""
          aria-hidden
          width={24}
          height={24}
          style={{
            display: 'block',
            marginBottom: 12,
            filter: 'drop-shadow(0 0 12px rgba(var(--accent-rgb), 0.35))',
          }}
        />
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontWeight: 400,
            marginBottom: 6,
          }}
        >
          Save this map
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 }}>
          <span className="badge badge-accent">{Object.keys(map).length} identifiers</span>{' '}
          <span style={{ marginLeft: 6 }}>
            Saved in this browser, encrypted with your local passphrase - never leaves it.
          </span>
        </p>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label className="form-label">Map name</label>
            <input
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. auth-service-refactor"
              required
              autoFocus
              maxLength={100}
            />
          </div>

          {error && (
            <p className="form-error" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose} style={{ flex: 1 }}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={saving || !name.trim()}
              style={{ flex: 1 }}
            >
              Save locally
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
