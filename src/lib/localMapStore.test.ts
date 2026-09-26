// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  localKeyConfig,
  localKeyState,
  setLocalPassphrase,
  unlockLocal,
  forgetLocal,
  lockLocalForTests,
  saveLocalMap,
  openLocalMap,
  listLocalMaps,
  deleteLocalMap,
  LocalKeyLockedError,
} from './localMapStore.js'

// Spec 018. Local maps used to sit in localStorage as plain JSON: the real
// identifier names, readable by anything with the browser profile.

const MAP = {
  __CLS__1: 'PaymentGateway',
  __FN__1: 'chargeCustomerCard',
  __VAR__1: 'invoiceSecretTotal',
}
const PASS = 'correct horse battery staple'

/** Every byte of storage, as one string - what an extension or a disk copy sees. */
function storageDump(): string {
  let s = ''
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    s += `${k}=${localStorage.getItem(k)}\n`
  }
  return s
}

function expectNoIdentifiers() {
  const dump = storageDump()
  for (const [placeholder, name] of Object.entries(MAP)) {
    expect(dump).not.toContain(name)
    expect(dump).not.toContain(placeholder)
  }
}

beforeEach(() => {
  localStorage.clear()
  lockLocalForTests()
  localKeyConfig.kdf = { name: 'PBKDF2-SHA256', iterations: 1000 }
})

describe('a no-account user (local passphrase)', () => {
  it('stores no identifier or placeholder anywhere in storage', async () => {
    await setLocalPassphrase(PASS, PASS)
    await saveLocalMap('billing', MAP)
    expectNoIdentifiers()
    expect(await openLocalMap(listLocalMaps()[0].id)).toEqual(MAP)
  })

  it('the picker lists name, count and date without the key; contents need it', async () => {
    await setLocalPassphrase(PASS, PASS)
    const meta = await saveLocalMap('billing', MAP)
    lockLocalForTests() // a reload
    expect(listLocalMaps()).toEqual([{ ...meta }])
    expect(listLocalMaps()[0]).toMatchObject({ name: 'billing', identifierCount: 3 })
    await expect(openLocalMap(meta.id)).rejects.toBeInstanceOf(LocalKeyLockedError)
  })

  it('once per session: after unlocking, maps open without asking again', async () => {
    await setLocalPassphrase(PASS, PASS)
    const a = await saveLocalMap('a', MAP)
    const b = await saveLocalMap('b', { __CLS__1: 'Other' })
    lockLocalForTests()
    expect(localKeyState()).toBe('locked')
    expect(await unlockLocal(PASS)).toBe(true)
    expect(localKeyState()).toBe('unlocked')
    expect(await openLocalMap(a.id)).toEqual(MAP)
    expect(await openLocalMap(b.id)).toEqual({ __CLS__1: 'Other' })
  })

  it('a wrong passphrase is refused and nothing opens', async () => {
    await setLocalPassphrase(PASS, PASS)
    const a = await saveLocalMap('a', MAP)
    lockLocalForTests()
    expect(await unlockLocal('wrong passphrase entirely')).toBe(false)
    expect(localKeyState()).toBe('locked')
    await expect(openLocalMap(a.id)).rejects.toBeInstanceOf(LocalKeyLockedError)
  })

  it('refuses mismatched or weak passphrases, and a second set', async () => {
    await expect(setLocalPassphrase(PASS, `${PASS}x`)).rejects.toThrow(/do not match/)
    await expect(setLocalPassphrase('short', 'short')).rejects.toThrow()
    expect(localKeyState()).toBe('none')
    await setLocalPassphrase(PASS, PASS)
    await expect(setLocalPassphrase(PASS, PASS)).rejects.toThrow(/already set/)
  })

  it('saving without the key is refused - never a plaintext write', async () => {
    await expect(saveLocalMap('x', MAP)).rejects.toBeInstanceOf(LocalKeyLockedError)
    expect(storageDump()).toBe('')
  })

  it('the key record holds no passphrase and no key', async () => {
    await setLocalPassphrase(PASS, PASS)
    expect(storageDump()).not.toContain(PASS)
  })

  it('forgetting removes the maps and the key record', async () => {
    await setLocalPassphrase(PASS, PASS)
    await saveLocalMap('local one', MAP)
    forgetLocal()
    expect(localKeyState()).toBe('none')
    expect(listLocalMaps()).toEqual([])
    expect(storageDump()).toBe('')
  })

  it('delete needs no key', async () => {
    await setLocalPassphrase(PASS, PASS)
    const a = await saveLocalMap('a', MAP)
    lockLocalForTests()
    deleteLocalMap(a.id)
    expect(listLocalMaps()).toEqual([])
  })
})

describe('purpose binding', () => {
  it('a Cloud-style envelope under the same key does not open as a local map', async () => {
    await setLocalPassphrase(PASS, PASS)
    const m = await saveLocalMap('real', MAP)
    // Re-encrypt the same map WITHOUT the local-map purpose, as a Cloud map is.
    const { getKeyForTests } = await import('./localMapStore.js')
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      getKeyForTests()!,
      new TextEncoder().encode(JSON.stringify(MAP))
    )
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
    const env = { iv: b64(iv), data: b64(new Uint8Array(ct)) }
    const stored = JSON.parse(localStorage.getItem('veilio_local_maps_v2')!)
    stored[0] = { ...stored[0], iv: env.iv, data: env.data }
    localStorage.setItem('veilio_local_maps_v2', JSON.stringify(stored))
    await expect(openLocalMap(m.id)).rejects.toThrow()
  })
})

describe('review fixes', () => {
  it('ciphertexts are bound to their entry: swapping two entries opens neither', async () => {
    await setLocalPassphrase(PASS, PASS)
    const a = await saveLocalMap('a', MAP)
    const b = await saveLocalMap('b', { __CLS__1: 'Other' })
    const stored = JSON.parse(localStorage.getItem('veilio_local_maps_v2')!) as {
      id: string
      iv: string
      data: string
    }[]
    const ea = stored.find((e) => e.id === a.id)!
    const eb = stored.find((e) => e.id === b.id)!
    ;[ea.iv, eb.iv, ea.data, eb.data] = [eb.iv, ea.iv, eb.data, ea.data]
    localStorage.setItem('veilio_local_maps_v2', JSON.stringify(stored))
    await expect(openLocalMap(a.id)).rejects.toThrow()
    await expect(openLocalMap(b.id)).rejects.toThrow()
  })
})
