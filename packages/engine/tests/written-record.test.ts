import { describe, it, expect } from 'vitest'
import { WRITTEN_RECORD_FILE, parseWrittenRecord, writtenRecordValue } from '../src/index.js'

// Spec 085 R2-3, Q6 = A (founder 2026-11-09): Veilio records, per project
// root, the hashes of the map and aliases it last wrote, so the guard can tell
// a map it wrote from one that came with an archive. One format for the CLI
// and the guard.
describe('the written-maps record (R2-3)', () => {
  const H = 'a'.repeat(64)
  const E = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  it('a value is the two hashes, the map first', () => {
    expect(writtenRecordValue(H, E)).toBe(`${H}:${E}`)
    expect(WRITTEN_RECORD_FILE).toBe('written.json')
  })

  it('parses a record of absolute roots to values', () => {
    expect(parseWrittenRecord(JSON.stringify({ '/work/p': `${H}:${E}` }))).toEqual({
      '/work/p': `${H}:${E}`,
    })
    expect(parseWrittenRecord(JSON.stringify({ 'C:\\work\\p': `${H}:${E}` }))).not.toBeNull()
  })

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a relative root', JSON.stringify({ 'work/p': `${H}:${E}` })],
    ['a value that is not two hashes', JSON.stringify({ '/work/p': 'x' })],
    ['a prototype key', '{"__proto__": "x"}'],
  ])('refuses %s', (_, text) => {
    expect(parseWrittenRecord(text)).toBeNull()
  })
})
