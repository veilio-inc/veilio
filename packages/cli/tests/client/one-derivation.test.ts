import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One derivation of the vault key, for every caller (spec 052 review). Three
 * copies had grown - `team unlock`, `vault unlock`, a personal map opened with
 * the passphrase - and a KDF change or a new check fixed in one would have left
 * the others wrong without anything failing. So the structure is pinned: only
 * `client/vault-key.ts` derives the key or checks the verifier.
 */
describe('the vault key is derived in one place', () => {
  it('only client/vault-key.ts calls deriveVaultKey or checkVaultVerifier', () => {
    const src = fileURLToPath(new URL('../../src/', import.meta.url))
    const callers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((n) => n.endsWith('.ts'))
      .filter((n) =>
        /\b(deriveVaultKey|checkVaultVerifier)\(/.test(readFileSync(join(src, n), 'utf8'))
      )
    expect(callers).toEqual(['client/vault-key.ts'])
  })
})
