import { useState, useCallback } from 'react'
import { anonymize, restore } from '@veilio/shared'
import type { SymbolMap, StrippedItem } from '@veilio/shared'
import Navbar from '../components/Navbar.js'
import CodePanel from '../components/CodePanel.js'
import StrippedPanel from '../components/StrippedPanel.js'
import SaveMapModal from '../components/SaveMapModal.js'
import MapOverlay from '../components/MapOverlay.js'
import { useLocalMaps } from '../hooks/useLocalMaps.js'
import { exportMap, importMap } from '../lib/localCrypto.js'

type Mode = 'send' | 'restore'

function Toast({ msg, type }: { msg: string; type: 'success' | 'error' | '' }) {
  if (!msg) return null
  return <div className={`toast ${type}`}>{msg}</div>
}

export default function ScrubPage() {
  const [mode, setMode] = useState<Mode>('send')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [currentMap, setCurrentMap] = useState<SymbolMap>({})
  const [strippedItems, setStrippedItems] = useState<StrippedItem[]>([])
  const [showSave, setShowSave] = useState(false)
  const [showOverlay, setShowOverlay] = useState(false)
  const [toast, setToast] = useState({ msg: '', type: '' as 'success' | 'error' | '' })

  const { maps: localMaps, getMap: getLocalMap } = useLocalMaps()

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: '' }), 3000)
  }

  const handleAnonymize = useCallback(() => {
    if (!input.trim()) return
    const result = anonymize(input, currentMap)
    setCurrentMap(result.map)
    setOutput(result.anonymized)
    setMode('send')
  }, [input, currentMap])

  const handleRestore = useCallback(() => {
    if (!input.trim()) return
    const result = restore(input, currentMap)
    setOutput(result.restored)
    setStrippedItems(result.strippedItems)
    setMode('restore')
  }, [input, currentMap])

  const handleClearMap = () => {
    setCurrentMap({})
    setOutput('')
    setInput('')
    setStrippedItems([])
    showToast('Map cleared')
  }

  async function handleExport() {
    if (Object.keys(currentMap).length === 0) {
      showToast('No map to export', 'error')
      return
    }
    const passphrase = prompt('Enter a passphrase to encrypt the export:')
    if (!passphrase) return
    try {
      const json = await exportMap(currentMap, passphrase)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'map.veilio'
      a.click()
      URL.revokeObjectURL(url)
      showToast('Map exported')
    } catch {
      showToast('Export failed', 'error')
    }
  }

  async function handleImport() {
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = '.veilio,.json'
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0]
      if (!file) return
      const passphrase = prompt('Enter the passphrase:')
      if (!passphrase) return
      try {
        const text = await file.text()
        const map = await importMap(text, passphrase)
        setCurrentMap(map)
        showToast(`Loaded ${Object.keys(map).length} identifiers`)
      } catch {
        showToast('Import failed — wrong passphrase?', 'error')
      }
    }
    fileInput.click()
  }

  function handleLoadLocalMap(id: string) {
    const map = getLocalMap(id)
    if (map) {
      setCurrentMap(map)
      showToast(`Loaded ${Object.keys(map).length} identifiers`)
    }
  }

  const mapCount = Object.keys(currentMap).length

  return (
    <div className="page">
      <Navbar />

      <div
        role="note"
        style={{
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          padding: '8px 24px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        ⚠️ Best-effort anonymization — always review the output before sharing. You are responsible
        for what you paste into AI tools.
      </div>

      <div style={{ padding: '16px 24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
        {/* Mode pills */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 4,
              background: 'var(--bg-surface)',
              padding: 4,
              borderRadius: 8,
              border: '1px solid var(--border)',
            }}
          >
            <ModeButton active={mode === 'send'} onClick={() => setMode('send')}>
              ① Send to AI
            </ModeButton>
            <ModeButton active={mode === 'restore'} onClick={() => setMode('restore')}>
              ② Restore from AI
            </ModeButton>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {mapCount > 0 && (
              <>
                <button
                  className="btn-ghost"
                  style={{ padding: '5px 12px', fontSize: 12 }}
                  onClick={() => setShowOverlay(true)}
                >
                  {mapCount} symbols
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: '5px 12px', fontSize: 12 }}
                  onClick={() => setShowSave(true)}
                >
                  Save map
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: '5px 12px', fontSize: 12 }}
                  onClick={handleExport}
                >
                  Export .veilio
                </button>
              </>
            )}
            <button
              className="btn-ghost"
              style={{ padding: '5px 12px', fontSize: 12 }}
              onClick={handleImport}
            >
              Import .veilio
            </button>
            {mapCount > 0 && (
              <button className="btn-danger" style={{ fontSize: 12 }} onClick={handleClearMap}>
                Clear map
              </button>
            )}
          </div>
        </div>

        {/* Quick-load local maps */}
        {localMaps.length > 0 && (
          <div
            style={{
              marginBottom: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
            >
              Load:
            </span>
            {localMaps.slice(0, 5).map((m) => (
              <button
                key={m.id}
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                onClick={() => handleLoadLocalMap(m.id)}
              >
                {m.name}{' '}
                <span style={{ color: 'var(--text-dim)' }}>({m.identifierCount})</span>
              </button>
            ))}
          </div>
        )}

        {/* Main panels */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: 12,
            alignItems: 'start',
          }}
        >
          <CodePanel
            label={mode === 'send' ? '① Your code' : '③ AI response'}
            value={input}
            onChange={setInput}
            placeholder={
              mode === 'send'
                ? 'Paste your code here. Real identifier names will be replaced with __P1__, __P2__, ...'
                : "Paste the AI's response here. Placeholders will be restored to real names."
            }
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 48 }}>
            <ActionButton
              onClick={mode === 'send' ? handleAnonymize : handleRestore}
              label={mode === 'send' ? 'Anonymize →' : 'Restore →'}
              disabled={!input.trim()}
            />
            {mode === 'send' && output && (
              <ActionButton
                onClick={() => {
                  setInput(output)
                  setOutput('')
                }}
                label="← Back"
                secondary
              />
            )}
          </div>

          <CodePanel
            label={mode === 'send' ? '② Anonymized (paste to AI)' : '④ Restored code'}
            value={output}
            readOnly
            placeholder={
              mode === 'send'
                ? 'Anonymized code will appear here. Copy and paste into your AI tool.'
                : 'Restored code with real names will appear here.'
            }
            badge={mode === 'send' && mapCount > 0 ? `${mapCount} placeholders` : undefined}
          />
        </div>

        {/* Stripped panel in restore mode */}
        {mode === 'restore' && strippedItems.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <StrippedPanel items={strippedItems} />
          </div>
        )}
      </div>

      {showSave && (
        <SaveMapModal
          map={currentMap}
          onClose={() => setShowSave(false)}
          onSaved={(name) => showToast(`Map "${name}" saved`)}
        />
      )}

      {showOverlay && <MapOverlay map={currentMap} onClose={() => setShowOverlay(false)} />}

      <Toast msg={toast.msg} type={toast.type} />
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 16px',
        borderRadius: 6,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#000' : 'var(--text-secondary)',
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        border: 'none',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

function ActionButton({
  onClick,
  label,
  disabled,
  secondary,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
  secondary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '10px 16px',
        background: secondary ? 'var(--bg-elevated)' : 'var(--accent)',
        color: secondary ? 'var(--text-secondary)' : '#000',
        fontWeight: 600,
        fontSize: 13,
        borderRadius: 6,
        border: secondary ? '1px solid var(--border)' : 'none',
        whiteSpace: 'nowrap',
        transition: 'background 0.15s',
      }}
    >
      {label}
    </button>
  )
}
