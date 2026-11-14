// Spec 093 item 12 (review round 1): the one writer of the 0600 JSON files
// under ~/.veilio, tested directly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeSecretJson } from '../src/secret-file.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veilio-secret-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8)

describe('writeSecretJson', () => {
  it('makes the folder and writes the value 0600', () => {
    const path = join(dir, 'store', 'key.json')
    writeSecretJson(path, { a: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 })
    expect(mode(path)).toBe('600')
    expect(readdirSync(join(dir, 'store'))).toEqual(['key.json'])
  })

  it('over a file anyone could read, leaves one only the owner can', () => {
    const path = join(dir, 'key.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o644)
    writeSecretJson(path, { a: 2 })
    expect(mode(path)).toBe('600')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 2 })
  })

  it('a rename that fails throws and leaves no temporary file behind', () => {
    const path = join(dir, 'key.json')
    // A folder with something in it: a file cannot be renamed over it.
    mkdirSync(join(path, 'inside'), { recursive: true })
    expect(() => writeSecretJson(path, { a: 3 })).toThrow()
    expect(readdirSync(dir)).toEqual(['key.json'])
  })

  it('does not write through a file left under a temporary name it might use', () => {
    const path = join(dir, 'key.json')
    const planted = `${path}.${process.pid}.tmp`
    writeFileSync(planted, 'planted')
    chmodSync(planted, 0o644)
    writeSecretJson(path, { a: 4 })
    expect(readFileSync(planted, 'utf8')).toBe('planted')
    expect(mode(path)).toBe('600')
  })
})
