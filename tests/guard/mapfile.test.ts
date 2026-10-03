import { describe, expect, it } from 'vitest'
import {
  mergeAdditions,
  parseMapFile,
  serialiseMapFile,
} from '../../plugins/veilio-guard/lib/mapfile.ts'

// .veilio/map.json is shared with the CLI and the MCP server. The guard only
// ever adds entries, and a placeholder must never mean two names.
describe('parseMapFile', () => {
  it('reads the CLI format, keeping where a pulled map came from', () => {
    const text = JSON.stringify({
      version: 1,
      map: { __CLS__1: 'QuasarLedgerReconciler' },
      remote: { id: 'm1', updatedAt: '2026-10-01T00:00:00Z' },
    })
    expect(parseMapFile(text)).toEqual({
      ok: true,
      stored: {
        version: 1,
        map: { __CLS__1: 'QuasarLedgerReconciler' },
        remote: { id: 'm1', updatedAt: '2026-10-01T00:00:00Z' },
      },
    })
  })

  it.each([
    ['not JSON', '{'],
    ['no map', '{"version":1}'],
    ['a value that is not text', '{"version":1,"map":{"__CLS__1":7}}'],
    ['an unknown version', '{"version":2,"map":{}}'],
    ['a list', '[]'],
  ])('refuses %s, rather than starting from an empty map', (_, text) => {
    const r = parseMapFile(text)
    expect(r.ok).toBe(false)
  })
})

describe('mergeAdditions', () => {
  it('adds new entries to what is on disk now', () => {
    expect(mergeAdditions({ __CLS__1: 'A' }, { __FN__1: 'b' })).toEqual({
      merged: { __CLS__1: 'A', __FN__1: 'b' },
      conflicts: [],
    })
  })

  it('an entry already on disk with the same name is not a conflict', () => {
    expect(mergeAdditions({ __CLS__1: 'A' }, { __CLS__1: 'A' }).conflicts).toEqual([])
  })

  it('a placeholder another writer gave a different name is a conflict, and the disk wins', () => {
    const r = mergeAdditions({ __CLS__2: 'Other' }, { __CLS__2: 'Mine', __FN__1: 'f' })
    expect(r.conflicts).toEqual(['__CLS__2'])
    expect(r.merged.__CLS__2).toBe('Other')
  })

  it('a name another writer already gave a different placeholder is a conflict too', () => {
    const r = mergeAdditions({ __CLS__7: 'Mine' }, { __CLS__2: 'Mine' })
    expect(r.conflicts).toEqual(['__CLS__2'])
    expect(r.merged).toEqual({ __CLS__7: 'Mine' })
  })
})

describe('serialiseMapFile', () => {
  it('writes byte for byte what the CLI writes', () => {
    const stored = {
      version: 1 as const,
      map: { __CLS__1: 'A' },
      remote: { id: 'm', updatedAt: 't' },
    }
    expect(serialiseMapFile(stored)).toBe(`${JSON.stringify(stored, null, 2)}\n`)
    expect(serialiseMapFile({ version: 1, map: {} })).toBe('{\n  "version": 1,\n  "map": {}\n}\n')
  })
})
