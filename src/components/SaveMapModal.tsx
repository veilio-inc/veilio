import { useState } from 'react'
import type { SymbolMap } from '@dlgshi/engine'
import { useLocalMaps } from '../hooks/useLocalMaps.js'

interface Props {
  map: SymbolMap
  onClose: () => void
  onSaved?: (name: string) => void
}

export default function SaveMapModal({ map, onClose, onSaved }: Props) {
  const { saveMap } = useLocalMaps()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    saveMap(name.trim(), map)
    onSaved?.(name.trim())
    onClose()
    setSaving(false)
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 400,
            marginBottom: 6,
          }}
        >
          Save map
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 }}>
          {Object.keys(map).length} identifiers · Saved locally in browser
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
