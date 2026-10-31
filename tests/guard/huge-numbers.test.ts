import { describe, expect, it } from 'vitest'
import { parseReservedFile } from '../../plugins/veilio-guard/lib/mapfile.ts'
import { restoreArgs, scrubSource } from '../../plugins/veilio-guard/lib/scrub.ts'

// Security audit: a planted reserved.json near 2^53 made two names share one
// placeholder, and restore wrote the wrong name into the file.
const file = (blocks: unknown) => JSON.stringify({ version: 1, blocks })

describe('the guard reads reserved.json', () => {
  it.each([
    [{ __VAR__: { start: 2 ** 53 - 1, end: 2 ** 53 + 99 } }],
    [{ __VAR__: { start: 1e21, end: 1e21 } }],
    [{ __VAR__: { start: 1e9, end: 1e9 + 1 } }],
    // Cloud 450a93ce: the server's numbers stop at 1e8.
    [{ __VAR__: { start: 1e8, end: 1e8 + 1 } }],
    [{ __VAR__: { start: 1, end: 20_000 } }],
  ])('%j is unreadable, never numbered from', (blocks) => {
    expect(parseReservedFile(file(blocks)).ok).toBe(false)
  })

  it('a sane block is read', () => {
    expect(parseReservedFile(file({ __VAR__: { start: 501, end: 1000 } }))).toMatchObject({
      ok: true,
      blocks: { __VAR__: { start: 501, end: 1000 } },
    })
  })

  it('a Read numbered from a huge block still gives each name its own placeholder', () => {
    const code = 'const ledgerAlpha = 1\nconst berthQuorum = 2\n'
    const start = 2 ** 53
    const r = scrubSource(code, {}, 'typescript', new Set(), undefined, {
      blocks: { __VAR__: { start, end: start + 100 } },
      tag: 'ABC123',
    })
    expect(new Set(Object.keys(r.additions)).size).toBe(2)
    expect(new Set(Object.values(r.additions)).size).toBe(2)
    expect(restoreArgs(r.text, r.additions)).toMatchObject({ text: code })
  })
})
