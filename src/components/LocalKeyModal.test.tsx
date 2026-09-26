// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import LocalKeyModal from './LocalKeyModal.js'
import {
  localKeyConfig,
  localKeyState,
  setLocalPassphrase,
  saveLocalMap,
  listLocalMaps,
  lockLocalForTests,
} from '../lib/localMapStore.js'

// Spec 018: the local passphrase - set once, asked once per session,
// unrecoverable and said so.

const PASS = 'correct horse battery staple'

afterEach(() => cleanup())

beforeEach(() => {
  localStorage.clear()
  lockLocalForTests()
  localKeyConfig.kdf = { name: 'PBKDF2-SHA256', iterations: 1000 }
})

function type(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('setting the local passphrase', () => {
  it('asks twice, requires the unrecoverable acknowledgement, then unlocks', async () => {
    const onUnlocked = vi.fn()
    render(<LocalKeyModal onUnlocked={onUnlocked} onClose={() => {}} />)
    expect(screen.getByText(/cannot be recovered/)).toBeTruthy()
    type('Local passphrase', PASS)
    type('Confirm local passphrase', PASS)
    fireEvent.click(screen.getByRole('button', { name: 'Set passphrase' }))
    expect(await screen.findByRole('alert')).toBeTruthy() // not acknowledged yet
    expect(onUnlocked).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Acknowledge local recovery warning'))
    fireEvent.click(screen.getByRole('button', { name: 'Set passphrase' }))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
    expect(localKeyState()).toBe('unlocked')
  })

  it('refuses two different passphrases', async () => {
    const onUnlocked = vi.fn()
    render(<LocalKeyModal onUnlocked={onUnlocked} onClose={() => {}} />)
    type('Local passphrase', PASS)
    type('Confirm local passphrase', `${PASS}!`)
    fireEvent.click(screen.getByLabelText('Acknowledge local recovery warning'))
    fireEvent.click(screen.getByRole('button', { name: 'Set passphrase' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/)
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(localKeyState()).toBe('none')
  })
})

describe('unlocking', () => {
  beforeEach(async () => {
    await setLocalPassphrase(PASS, PASS)
    lockLocalForTests()
  })

  it('offers unlock (not set) once a passphrase exists', () => {
    render(<LocalKeyModal onUnlocked={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
    expect(screen.queryByLabelText('Confirm local passphrase')).toBeNull()
  })

  it('a wrong passphrase is refused with a message that says nothing about the maps', async () => {
    const onUnlocked = vi.fn()
    render(<LocalKeyModal onUnlocked={onUnlocked} onClose={() => {}} />)
    type('Local passphrase', 'not the passphrase at all')
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That passphrase did not unlock your local maps.'
    )
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('the right passphrase unlocks', async () => {
    const onUnlocked = vi.fn()
    render(<LocalKeyModal onUnlocked={onUnlocked} onClose={() => {}} />)
    type('Local passphrase', PASS)
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled())
    expect(localKeyState()).toBe('unlocked')
  })
})

describe('forgot passphrase', () => {
  it('explains there is no recovery, then deletes the local maps on request', async () => {
    await setLocalPassphrase(PASS, PASS)
    await saveLocalMap('doomed', { __CLS__1: 'Secret' })
    lockLocalForTests()
    const onForgotten = vi.fn()
    render(<LocalKeyModal onUnlocked={() => {}} onClose={() => {}} onForgotten={onForgotten} />)
    fireEvent.click(screen.getByRole('button', { name: 'Forgot passphrase?' }))
    expect(screen.getByText(/nobody - not Veilio, not this browser - can open them/)).toBeTruthy()
    expect(listLocalMaps()).toHaveLength(1) // nothing deleted just by looking
    fireEvent.click(screen.getByRole('button', { name: 'Delete local maps' }))
    expect(listLocalMaps()).toEqual([])
    expect(localKeyState()).toBe('none')
    expect(onForgotten).toHaveBeenCalled()
  })
})
