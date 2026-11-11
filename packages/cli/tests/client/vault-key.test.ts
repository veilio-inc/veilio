import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vaultKeyFor } from '../../src/client/vault-key.js'
import { readCredential } from '../../src/credential.js'
import { FakeCloud, PASSPHRASE, signIn } from '../helpers/fake-cloud.js'

/**
 * The server holds the KDF cost, so a compromised or hostile server chooses how
 * long this machine spins before a passphrase is even checked. The cost is
 * bounded on both sides: too high is a denial of service, too low is a vault
 * opened (and so a passphrase attacked) at a price the server picked.
 */
let home: string
let cloud: FakeCloud

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-vault-key-'))
  cloud = new FakeCloud()
  await cloud.withVault()
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

async function open(iterations: unknown) {
  cloud.vault!.kdf = { name: 'PBKDF2-SHA256', iterations: iterations as number }
  const credential = readCredential(home)
  if (!credential) throw new Error('no credential')
  return vaultKeyFor(credential, async () => PASSPHRASE)
}

describe('the vault KDF cost the server reports', () => {
  it('opens at the normal cost', async () => {
    expect((await open(600_000)).ok).toBe(true)
  })

  it.each([4_000_001, 2_000_000_000, 1000, 599_999, 0, -1, 1.5, Number.NaN, '600000'])(
    'refuses %s without deriving',
    async (n) => {
      const spy = vi.spyOn(globalThis.crypto.subtle, 'deriveKey')
      const r = await open(n)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.refusal.code).toBe('vault_kdf_refused')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  )

  it('refuses another KDF name', async () => {
    cloud.vault!.kdf = { name: 'scrypt', iterations: 600_000 }
    const credential = readCredential(home)!
    const r = await vaultKeyFor(credential, async () => PASSPHRASE)
    expect(r.ok).toBe(false)
  })
})
