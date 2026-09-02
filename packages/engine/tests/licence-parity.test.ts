import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * The engine and the edition it ships inside are offered on the same terms.
 *
 * They are separate artifacts — the engine goes to npm, the app ships as a
 * container and a tarball — so nothing structural keeps their licences in step.
 * Two copies of one legal text is the arrangement where one gets amended and the
 * other does not, and the resulting question ("which one governs?") is answered
 * by a lawyer rather than by a diff.
 */

const require_ = createRequire(import.meta.url)
const ENGINE_LICENSE = new URL('../LICENSE', import.meta.url).pathname
const CE_LICENSE = new URL('../../../LICENSE', import.meta.url).pathname

describe('licence parity', () => {
  it('ships the same terms as the Community Edition it belongs to', () => {
    expect(readFileSync(ENGINE_LICENSE, 'utf8')).toBe(readFileSync(CE_LICENSE, 'utf8'))
  })

  it('is the Veilio Community License, named as such', () => {
    // Not just "identical to whatever the root says" — both must actually be the
    // licence this project publishes under. Two matching wrong files would pass
    // the test above.
    const text = readFileSync(ENGINE_LICENSE, 'utf8')
    expect(text).toMatch(/Veilio Community License/)
    expect(text).toMatch(/Version 1\.0/)
  })

  it('declares the licence the way npm resolves a non-SPDX one', () => {
    // `SEE LICENSE IN LICENSE` is meaningless unless the file is in the tarball.
    const pkg = require_('../package.json') as { license?: string; files?: string[] }
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE')
    expect(pkg.files).toContain('LICENSE')
  })
})
