// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ScrubPage from './ScrubPage.js'
import DashboardPage from './DashboardPage.js'
import SaveMapModal from '../components/SaveMapModal.js'
import {
  localKeyConfig,
  lockLocalForTests,
  setLocalPassphrase,
  saveLocalMap,
  listLocalMaps,
} from '../lib/localMapStore.js'

// Spec 018 in the Community Edition web app: local maps encrypted at rest.

const PASS = 'correct horse battery staple'

beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})
beforeEach(() => {
  localStorage.clear()
  lockLocalForTests()
  localKeyConfig.kdf = { name: 'PBKDF2-SHA256', iterations: 1000 }
})
afterEach(() => cleanup())

function storageDump(): string {
  let s = ''
  for (let i = 0; i < localStorage.length; i++) s += localStorage.getItem(localStorage.key(i)!)
  return s
}

function setPassphraseInModal() {
  fireEvent.change(screen.getByLabelText('Local passphrase'), { target: { value: PASS } })
  fireEvent.change(screen.getByLabelText('Confirm local passphrase'), { target: { value: PASS } })
  fireEvent.click(screen.getByLabelText('Acknowledge local recovery warning'))
  fireEvent.click(screen.getByRole('button', { name: 'Set passphrase' }))
}

describe('saving locally', () => {
  it('asks for a passphrase the first time, then stores only ciphertext', async () => {
    const onSaved = vi.fn()
    render(
      <SaveMapModal map={{ __CLS__1: 'InvoiceSecret' }} onClose={() => {}} onSaved={onSaved} />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save locally' }))
    await screen.findByLabelText('Local passphrase')
    expect(localStorage.length).toBe(0)
    setPassphraseInModal()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('mine'))
    expect(listLocalMaps().map((m) => m.name)).toEqual(['mine'])
    expect(storageDump()).not.toContain('InvoiceSecret')
  })
})

describe('saving locally when storage is full', () => {
  it('says so, and never falls back to anything unencrypted', async () => {
    await setLocalPassphrase(PASS, PASS)
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
    try {
      const onSaved = vi.fn()
      render(
        <SaveMapModal map={{ __CLS__1: 'InvoiceSecret' }} onClose={() => {}} onSaved={onSaved} />
      )
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save locally' }))
      expect((await screen.findByRole('alert')).textContent).toMatch(/quota|Could not save the map/)
      expect(onSaved).not.toHaveBeenCalled()
    } finally {
      full.mockRestore()
    }
    expect(storageDump()).not.toContain('InvoiceSecret')
  })
})

describe('the tool page', () => {
  const renderPage = () =>
    render(
      <MemoryRouter>
        <ScrubPage />
      </MemoryRouter>
    )

  it('a locked map asks for the passphrase, then loads', async () => {
    await setLocalPassphrase(PASS, PASS)
    await saveLocalMap('encrypted one', { __CLS__1: 'Invoice' })
    lockLocalForTests()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /encrypted one/ }))
    fireEvent.change(await screen.findByLabelText('Local passphrase', {}, { timeout: 10_000 }), {
      target: { value: PASS },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText(/Loaded 1 identifiers/, {}, { timeout: 10_000 })).toBeTruthy()
  }, 30_000)
})

describe('the dashboard', () => {
  it('exporting JSON from a locked map asks for the passphrase first', async () => {
    await setLocalPassphrase(PASS, PASS)
    await saveLocalMap('exported', { __CLS__1: 'Invoice' })
    lockLocalForTests()
    const created: Blob[] = []
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x'))
    URL.revokeObjectURL = vi.fn()
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: '.json' }))
    fireEvent.change(await screen.findByLabelText('Local passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(JSON.parse(await created[0].text())).toEqual({ __CLS__1: 'Invoice' })
  })
})
