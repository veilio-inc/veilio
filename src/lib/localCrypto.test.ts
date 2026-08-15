// @vitest-environment jsdom
//
// This module is browser code, so it is exercised in a browser-like realm
// rather than bare Node. That matters beyond realism: values crossing the
// jsdom realm boundary fail `instanceof` checks against Node's own globals, so
// a node-environment run silently skips the very code paths that break in
// practice. The rest of the suite (the engine) stays on the default env.
import { describe, it, expect, beforeAll } from 'vitest'
import type { SymbolMap } from '@veilio-inc/engine'
import { exportMap, importMap } from './localCrypto.js'
import { InvalidMapError } from './importedMap.js'
import { WeakPassphraseError, MIN_PASSPHRASE_LENGTH } from './passphrase.js'

// Every export runs a real 600k-iteration PBKDF2 derive, so keep the round-trip
// count low and give these a longer timeout.

// Exports now enforce a passphrase floor, so tests cannot use 'pw'. Kept as one
// constant rather than a literal per test: a future raise to the floor should be
// a one-line change here, not a hunt through the file.
const PASSPHRASE = 'quiet-harbour-morning'

// A real .veilio file captured from before parameters were recorded: encrypted
// at the legacy 100k iterations, with no kdf field. FROZEN ON PURPOSE — do not
// regenerate it. Rebuilding this fixture with the current code would make it
// re-encrypt at the current cost and quietly stop testing anything, which is
// precisely how a cost increase would ship having silently orphaned every
// .veilio file already on a user's disk.
const LEGACY_FILE = {
  v: 1,
  alg: 'AES-256-GCM-PBKDF2',
  salt: 'tKulO4yTGC7keBxb//eO4Q==',
  iv: 'dFFe2/R28m70GJZ2',
  data: '3Eq4s85IfR6/d7ohzGYEM7ys6lzoB4KTdYsrUQ9V44gf2r25PE8rA99Kf2q8RkyDeWfyE3BEo+6qYkDVR3xIEg==',
}
const LEGACY_PASSPHRASE = 'legacy-passphrase'
const LEGACY_MAP = { __P1__: 'LegacyService', __P2__: 'chargeCard' }

describe('exportMap / importMap', () => {
  it('round-trips a map with the correct passphrase', { timeout: 15_000 }, async () => {
    const plain = { __P1__: 'PaymentService', __P2__: 'chargeCard' }
    expect(await importMap(await exportMap(plain, PASSPHRASE), PASSPHRASE)).toEqual(plain)
  })

  it('throws when imported with the wrong passphrase', { timeout: 15_000 }, async () => {
    const file = await exportMap({ __P1__: 'Secret' }, 'right-passphrase')
    await expect(importMap(file, 'wrong-passphrase')).rejects.toThrow()
  })

  // Hardcoded rather than compared against CURRENT_FILE_KDF, which would make
  // this tautological: a silent change to the constant should fail here.
  it('records the KDF parameters it used', { timeout: 15_000 }, async () => {
    const file = JSON.parse(await exportMap({ __P1__: 'X' }, PASSPHRASE))
    expect(file.kdf).toEqual({ name: 'PBKDF2-SHA256', iterations: 600_000 })
  })

  it(
    'imports a file written before KDF parameters were recorded',
    { timeout: 15_000 },
    async () => {
      expect(await importMap(JSON.stringify(LEGACY_FILE), LEGACY_PASSPHRASE)).toEqual(LEGACY_MAP)
    }
  )

  // The file records 100k while new files are written at a higher cost, so this
  // only passes if the recorded value drives derivation instead of the current
  // constant. That is the whole point of recording them.
  it(
    'derives with the parameters recorded in the file, not the current ones',
    { timeout: 15_000 },
    async () => {
      const recorded = { ...LEGACY_FILE, kdf: { name: 'PBKDF2-SHA256', iterations: 100_000 } }
      expect(await importMap(JSON.stringify(recorded), LEGACY_PASSPHRASE)).toEqual(LEGACY_MAP)
    }
  )

  it('refuses a file whose KDF parameters would pin the browser', async () => {
    const file = JSON.parse(await exportMap({ __P1__: 'X' }, PASSPHRASE))
    file.kdf = { name: 'PBKDF2-SHA256', iterations: 1_000_000_000 }
    await expect(importMap(JSON.stringify(file), PASSPHRASE)).rejects.toThrow(/iteration count/i)
  })

  // A real export — a whole project's symbol map — is far larger than the
  // handful of entries above, and the base64 step used to be written in a way
  // that blew the call stack once the ciphertext passed a few tens of KB.
  it('round-trips a map large enough to overflow a spread call', { timeout: 30_000 }, async () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 5000; i++) big[`__P${i}__`] = `VeryDescriptiveIdentifierName_${i}`
    const file = await exportMap(big, PASSPHRASE)
    expect(JSON.parse(file).data.length).toBeGreaterThan(64_000)
    expect(await importMap(file, PASSPHRASE)).toEqual(big)
  })
})

// The envelope check is the first thing applied to a file the user picked off
// disk, and it runs before any key derivation. Untested until now.
describe('importMap rejects a malformed envelope', () => {
  it('refuses a file that is not JSON at all', async () => {
    // Picking the wrong file is the common case, not the hostile one.
    await expect(importMap('not json', PASSPHRASE)).rejects.toThrow()
  })

  it('refuses an unknown format version', async () => {
    // v2 will exist one day; guessing at it would derive the wrong key and
    // surface as a decryption failure the user cannot act on.
    const file = { ...LEGACY_FILE, v: 2 }
    await expect(importMap(JSON.stringify(file), PASSPHRASE)).rejects.toThrow(/format/i)
  })

  it('refuses an unknown algorithm', async () => {
    const file = { ...LEGACY_FILE, alg: 'AES-128-CBC' }
    await expect(importMap(JSON.stringify(file), PASSPHRASE)).rejects.toThrow(/format/i)
  })

  it('refuses an envelope missing its fields entirely', async () => {
    await expect(importMap('{}', PASSPHRASE)).rejects.toThrow(/format/i)
  })

  it('rejects before deriving a key, so a bad file fails instantly', async () => {
    // The check is worth nothing if it lands after 600k iterations.
    const started = performance.now()
    await expect(importMap('{}', PASSPHRASE)).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('refuses an unsupported KDF before deriving anything', async () => {
    const file = { ...LEGACY_FILE, kdf: { name: 'argon2id', iterations: 3 } }
    await expect(importMap(JSON.stringify(file), PASSPHRASE)).rejects.toThrow(/Unsupported KDF/i)
  })
})

// assertUsablePassphrase has its own suite; these assert it is reached on the
// export path and — just as importantly — not on the import path.
describe('exportMap enforces the passphrase floor (ROADMAP E8)', () => {
  const MAP = { __FN__1: 'settleInvoice' }

  it('refuses to write a file under a too-short passphrase', async () => {
    await expect(exportMap(MAP, 'pw')).rejects.toThrow(WeakPassphraseError)
  })

  it('refuses before doing any work, so a weak choice fails instantly', async () => {
    // If the check ran after derivation the user would wait 600k iterations to
    // be told their passphrase was too short.
    const started = performance.now()
    await expect(exportMap(MAP, 'short')).rejects.toThrow(WeakPassphraseError)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('explains the length requirement rather than just failing', async () => {
    await expect(exportMap(MAP, 'pw')).rejects.toThrow(new RegExp(String(MIN_PASSPHRASE_LENGTH)))
  })

  it('never applies the floor on import', async () => {
    // Files written by an older build may be protected by a passphrase this
    // check would now reject. Enforcing the floor on import would lock people
    // out of maps they already hold — data loss dressed up as hardening, the
    // same reasoning that keeps LEGACY_FILE_KDF frozen.
    //
    // A 2-character passphrase therefore has to reach decryption and fail on
    // the ciphertext, not be turned away at the door.
    await expect(importMap(JSON.stringify(LEGACY_FILE), 'pw')).rejects.not.toThrow(
      WeakPassphraseError
    )
  }, 15_000)
})

// parseSymbolMap has its own suite; these assert it is actually *reached* on the
// import path. Wiring is the part that silently regresses — the validator can be
// perfect and unused.
describe('importMap validates what it decrypts', () => {
  // Each case needs a genuine encrypted file, and every derive costs a 600k
  // PBKDF2 round, so the files are built once and shared.
  let hostileFile: string
  let arrayFile: string
  let badValueFile: string

  beforeAll(async () => {
    // JSON.parse gives "__proto__" as an own enumerable property, which
    // JSON.stringify then writes back out — an object literal would not.
    const pollution = JSON.parse('{"__proto__": {"polluted": true}}')
    hostileFile = await exportMap(pollution as SymbolMap, PASSPHRASE)
    arrayFile = await exportMap(['__FN__1', 'settle'] as unknown as SymbolMap, PASSPHRASE)
    badValueFile = await exportMap({ __FN__1: 42 } as unknown as SymbolMap, PASSPHRASE)
  }, 60_000)

  it('refuses a correctly encrypted file carrying a prototype-pollution key', async () => {
    await expect(importMap(hostileFile, PASSPHRASE)).rejects.toThrow(InvalidMapError)
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('refuses a file that decrypts to a list', async () => {
    await expect(importMap(arrayFile, PASSPHRASE)).rejects.toThrow(InvalidMapError)
  })

  it('refuses a file whose values are not text', async () => {
    await expect(importMap(badValueFile, PASSPHRASE)).rejects.toThrow(InvalidMapError)
  })

  it('reports InvalidMapError, not a decryption failure', async () => {
    // The UI branches on this to avoid telling the reader their passphrase was
    // wrong when it was right and the file was bad.
    await expect(importMap(hostileFile, PASSPHRASE)).rejects.toBeInstanceOf(InvalidMapError)
  })

  it('still accepts a legitimate round trip once validation is in the path', async () => {
    const map = { __CLS__1: 'InvoiceLedger', __FN__2: 'settleInvoice', __P3__: 'legacyStyle' }
    expect(await importMap(await exportMap(map, PASSPHRASE), PASSPHRASE)).toEqual(map)
  }, 30_000)
})
