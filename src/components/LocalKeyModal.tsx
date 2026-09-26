import { useState } from 'react'
import {
  localKeyState,
  setLocalPassphrase,
  unlockLocal,
  forgetLocal,
} from '../lib/localMapStore.js'

/**
 * The local passphrase for maps saved in this browser (spec 018).
 *
 * Set once, asked once per session. It never leaves the browser and cannot be
 * recovered - which is said when it is set and again at unlock, where the only
 * way out of a forgotten passphrase is deleting the local maps.
 */

interface Props {
  onUnlocked: () => void
  onClose: () => void
  /** Called after the local maps were deleted from the "forgot" path. */
  onForgotten?: () => void
}

export default function LocalKeyModal({ onUnlocked, onClose, onForgotten }: Props) {
  const [mode, setMode] = useState<'set' | 'unlock' | 'forget'>(
    localKeyState() === 'none' ? 'set' : 'unlock'
  )
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setWorking(true)
    try {
      if (mode === 'set') {
        if (!agreed) {
          setError('Please confirm you understand the passphrase cannot be recovered.')
          return
        }
        await setLocalPassphrase(pass, confirm)
        onUnlocked()
      } else if (mode === 'unlock') {
        if (await unlockLocal(pass)) onUnlocked()
        // The same answer for every failure: nothing about the maps is revealed.
        else setError('That passphrase did not unlock your local maps.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the passphrase')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 700,
            marginBottom: 8,
          }}
        >
          {mode === 'set'
            ? 'Protect your local maps'
            : mode === 'unlock'
              ? 'Unlock your local maps'
              : 'Forgot your passphrase?'}
        </h2>

        {mode === 'forget' ? (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              Local maps are encrypted with your passphrase, and nobody - not Veilio, not this
              browser - can open them without it. The only way forward is to delete them and start
              again with a new passphrase.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  forgetLocal()
                  onForgotten?.()
                  onClose()
                }}
              >
                Delete local maps
              </button>
              <button type="button" className="btn-ghost" onClick={() => setMode('unlock')}>
                Back
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              {mode === 'set'
                ? 'Maps you save in this browser are encrypted with this passphrase, so the names in them stay private to you. It never leaves this browser.'
                : 'Enter the passphrase you set for maps saved in this browser. You are asked once per session.'}
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="local-pass">
                Passphrase
              </label>
              <input
                id="local-pass"
                aria-label="Local passphrase"
                className="form-input"
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </div>
            {mode === 'set' && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="local-confirm">
                    Confirm passphrase
                  </label>
                  <input
                    id="local-confirm"
                    aria-label="Confirm local passphrase"
                    className="form-input"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                <label
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    marginBottom: 12,
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label="Acknowledge local recovery warning"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    I understand that{' '}
                    <strong style={{ color: 'var(--danger)' }}>
                      this passphrase cannot be recovered
                    </strong>
                    . If I forget it, my local maps are permanently unreadable.
                  </span>
                </label>
              </>
            )}
            {error && (
              <p className="form-error" role="alert" style={{ marginBottom: 12 }}>
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="submit" className="btn-primary" disabled={working || !pass}>
                {working ? 'Working…' : mode === 'set' ? 'Set passphrase' : 'Unlock'}
              </button>
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              {mode === 'unlock' && (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ marginLeft: 'auto', fontSize: 12 }}
                  onClick={() => setMode('forget')}
                >
                  Forgot passphrase?
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
