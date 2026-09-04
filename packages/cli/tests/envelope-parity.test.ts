import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openMap, sealMap, CURRENT_FILE_KDF } from '@veilio-inc/engine'

/**
 * Spec 005 T004 — the terminal opens what the browser sealed.
 *
 * This is NOT a second copy of the engine's own parity test, and the difference
 * is the point. That one asks whether the format is stable. This one asks
 * whether the CLI can reach it **through its declared dependency range** — a
 * different failure with a different cause: a range that never rose, a workspace
 * that stopped linking, an export that was never added to the engine's public
 * surface.
 *
 * The fixture is committed here rather than imported from the engine's tests,
 * because a test that reaches into another package's test directory passes for
 * reasons that have nothing to do with what ships. This one resolves
 * `@veilio-inc/engine` exactly the way the published CLI does.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'browser-sealed.veilio')
const PASS = 'correct horse battery staple'

describe('the envelope, reached the way the CLI reaches it', () => {
  it('opens a file sealed by the browser implementation', async () => {
    // Sealed by the Cloud frontend's localCrypto.ts. If this fails, a map
    // exported from the web app cannot be opened from a terminal — which is the
    // entire feature 005 exists to build.
    const map = await openMap(readFileSync(FIXTURE, 'utf8'), PASS)
    expect(map).toEqual({
      __CLS__1: 'PaymentGateway',
      __FN__1: 'chargeCard',
      __VAR__1: 'customerRef',
    })
  })

  it('seals a file the same implementation opens', async () => {
    const map = { __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' }
    expect(await openMap(await sealMap(map, PASS), PASS)).toEqual(map)
  })

  it('is exported from the engine root, not a deep path', async () => {
    // The CLI imports from '@veilio-inc/engine'. If the envelope were reachable
    // only at '@veilio-inc/engine/dist/envelope.js', this package would be
    // depending on the engine's file layout rather than its API — and the
    // engine's exports map does not publish deep paths.
    const mod = await import('@veilio-inc/engine')
    for (const name of ['openMap', 'sealMap', 'parseKdfParams', 'assertUsablePassphrase']) {
      expect(typeof (mod as Record<string, unknown>)[name], `${name} must be exported`).toBe(
        'function'
      )
    }
    expect(CURRENT_FILE_KDF.iterations).toBe(600_000)
  })

  it('resolves an engine new enough to have it', async () => {
    // The failure this guards is the one the range checks exist for, seen from
    // the other side: an engine that satisfies a stale range but predates the
    // envelope would fail here as an undefined import rather than a version
    // mismatch, which reads as a broken build instead of a missing bump.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@veilio-inc/engine']).toMatch(/^\^1\.[5-9]\.\d+$|^\^[2-9]\./)
  })
})
