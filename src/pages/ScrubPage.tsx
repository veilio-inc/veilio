import { useState, useCallback } from 'react'
import { anonymize, restore } from '@veilio-inc/engine'
import type { SecretFinding, SymbolMap, StrippedItem } from '@veilio-inc/engine'
import Navbar from '../components/Navbar.js'
import CodePanel from '../components/CodePanel.js'
import SecretPanel from '../components/SecretPanel.js'
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
  const [secretFindings, setSecretFindings] = useState<SecretFinding[]>([])
  const [toast, setToast] = useState({ msg: '', type: '' as 'success' | 'error' | '' })

  const { maps: localMaps, getMap: getLocalMap } = useLocalMaps()

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: '' }), 3000)
  }

  const handleAnonymize = useCallback(() => {
    if (!input.trim()) return
    const result = anonymize(input, { existingMap: currentMap })
    setCurrentMap(result.map)
    setOutput(result.anonymized)
    setSecretFindings(result.secrets)
    setInput('')
    setMode('send')
  }, [input, currentMap])

  const handleRestore = useCallback(() => {
    if (!input.trim()) return
    const result = restore(input, currentMap)
    setOutput(result.restored)
    setStrippedItems(result.strippedItems)
    // Findings describe the anonymize pass; they'd be stale next to a restore.
    setSecretFindings([])
    setInput('')
    setMode('restore')
  }, [input, currentMap])

  const handleClearMap = () => {
    setCurrentMap({})
    setOutput('')
    setInput('')
    setStrippedItems([])
    setSecretFindings([])
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          background: 'linear-gradient(180deg, rgba(204,120,92,0.07), rgba(204,120,92,0.02))',
          borderBottom: '1px solid var(--border)',
          padding: '9px 24px',
          marginTop: 12,
          fontSize: 12,
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em',
            color: 'var(--accent)',
            background: 'var(--accent-dim)',
            border: '1px solid rgba(204,120,92,0.35)',
            borderRadius: 20,
            padding: '1px 8px',
          }}
        >
          BEST-EFFORT
        </span>
        Always review the output before sharing. You are responsible for what you paste into AI
        tools.
      </div>

      <LandingHero />

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
          <div className="seg">
            <span
              aria-hidden
              className="seg-indicator"
              style={{ transform: mode === 'restore' ? 'translateX(100%)' : 'translateX(0)' }}
            />
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
                {m.name} <span style={{ color: 'var(--text-dim)' }}>({m.identifierCount})</span>
              </button>
            ))}
          </div>
        )}

        {/* Credentials found in the last anonymize pass. Above the panels, and
            therefore above the copy action — a warning placed after the thing
            it warns about gets read too late. */}
        {mode === 'send' && <SecretPanel findings={secretFindings} />}

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

function LandingHero() {
  return (
    <header
      style={{
        maxWidth: 1400,
        margin: '0 auto',
        width: '100%',
        padding: '40px 24px 8px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 40,
      }}
    >
      <div style={{ flex: '1 1 460px', maxWidth: 600 }}>
        <div
          className="rise"
          style={{
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...({ '--i': 0 } as any),
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            background: 'var(--accent-dim)',
            border: '1px solid rgba(204,120,92,0.30)',
            borderRadius: 20,
            padding: '4px 12px',
            marginBottom: 20,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent)',
              boxShadow: '0 0 8px var(--accent)',
            }}
          />
          Client-side · nothing leaves your browser
        </div>

        <h1
          className="rise"
          style={{
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...({ '--i': 1 } as any),
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(38px, 5.5vw, 58px)',
            fontWeight: 400,
            lineHeight: 1.04,
            letterSpacing: '-0.02em',
            margin: 0,
          }}
        >
          Send your code to AI.
          <br />
          <span className="text-gradient" style={{ fontStyle: 'italic' }}>
            Keep your secrets.
          </span>
        </h1>

        <p
          className="rise"
          style={{
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...({ '--i': 2 } as any),
            color: 'var(--text-secondary)',
            fontSize: 16,
            lineHeight: 1.6,
            maxWidth: 480,
            marginTop: 18,
          }}
        >
          Veilio veils real identifiers behind placeholders before they ever leave your browser —
          then restores them when the answer comes back.
        </p>

        <div
          className="trust-strip rise"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          style={{ ...({ '--i': 3 } as any) }}
        >
          <span className="trust-item">100% client-side</span>
          <span className="trust-item">Zero runtime deps</span>
          <span className="trust-item">Free, even commercially</span>
        </div>
      </div>

      <RedactionDemo />
    </header>
  )
}

/** The brand gesture: a code card whose secrets are swept under redaction bars. */
function RedactionDemo() {
  const Line = ({ children, indent = 0 }: { children: React.ReactNode; indent?: number }) => (
    <div style={{ paddingLeft: indent * 18, whiteSpace: 'pre', minHeight: 22 }}>{children}</div>
  )
  const kw = { color: '#C99B6E' }
  const fn = { color: '#7FB3D5' }
  const str = { color: '#8FB98F' }
  return (
    <div
      className="rise surface"
      style={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ '--i': 3 } as any),
        flex: '0 1 440px',
        padding: 0,
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(20,18,16,0.5)',
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#E05C5C' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#D9A441' }} />
        <span
          style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--success)' }}
        />
        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
          auth.service.ts
        </span>
      </div>
      <div
        style={{
          padding: '16px 18px',
          fontSize: 13,
          lineHeight: 1.85,
          background: 'var(--code-bg)',
          color: 'var(--code-text)',
        }}
      >
        <Line>
          <span style={kw}>const</span> <span className="redact">apiKey</span> ={' '}
          <span style={str}>
            &quot;<span className="redact">sk-live-9f2a</span>&quot;
          </span>
        </Line>
        <Line>
          <span style={kw}>function</span> <span style={fn}>connect</span>(
          <span className="redact">dbPassword</span>) &#123;
        </Line>
        <Line indent={1}>
          <span style={kw}>return</span> <span style={fn}>db</span>.<span style={fn}>auth</span>(
          <span className="redact">dbPassword</span>)
        </Line>
        <Line>&#125;</Line>
        <div style={{ height: 10 }} />
        <Line>
          <span style={{ color: 'var(--text-dim)' }}>
            {'// → veiled before it reaches the model'}
          </span>
        </Line>
        <Line>
          <span style={kw}>const</span> <span style={{ color: 'var(--accent)' }}>__P1__</span> ={' '}
          <span style={str}>&quot;__P2__&quot;</span>
        </Line>
      </div>
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
    <button className={`seg-btn${active ? ' active' : ''}`} onClick={onClick}>
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
        background: secondary
          ? 'var(--bg-elevated)'
          : 'linear-gradient(180deg, #D98968 0%, var(--accent) 55%, var(--accent-hover) 100%)',
        color: secondary ? 'var(--text-secondary)' : '#fff',
        fontWeight: 600,
        fontSize: 13,
        borderRadius: 6,
        border: secondary ? '1px solid var(--border)' : 'none',
        boxShadow: secondary
          ? 'none'
          : '0 1px 0 rgba(250,249,247,0.18) inset, 0 8px 22px -8px var(--accent-glow)',
        whiteSpace: 'nowrap',
        transition: 'transform 0.12s ease, box-shadow 0.15s ease, filter 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}
