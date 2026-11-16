import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAP_LIMITS, restore } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_FINDINGS, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap } from '../src/store.js'

// A value longer than a map may hold stays masked, and nothing is lost: the
// map is not saved, nothing is printed, and the refusal names the entry. Up to
// the limit it is saved and restores exactly.

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-long-'))
  mkdirSync(join(cwd, '.git'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)

async function scrub(source: string) {
  writeFileSync(join(cwd, 'logo.ts'), source)
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    stdin: async () => '',
    stdinBytes: async function* () {
      yield Buffer.from('')
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  return { code: await main(['scrub', '--quiet', 'logo.ts'], io), out, err }
}

const source = (word: string): string => `const logo = "${word}"\n`

describe('veilio scrub of a file with one very long value', () => {
  it.each([150_000, MAP_LIMITS.valueLength])(
    '%i characters: saved, and the output restores to the file',
    async (length) => {
      const text = source('a'.repeat(length))
      const r = await scrub(text)
      expect(r.code, r.err).toBe(EXIT_OK)
      const map = loadMap(mapPath())
      expect(Object.values(map)).toContain('a'.repeat(length))
      expect(restore(r.out, map).restored).toBe(text)
    }
  )

  it('one character over the limit: nothing saved, nothing printed, the entry named', async () => {
    // A map from an earlier run, to be found untouched.
    expect((await scrub('const settleLedger = 1\n')).code).toBe(EXIT_OK)
    const before = readFileSync(mapPath(), 'utf8')
    const word = 'a'.repeat(MAP_LIMITS.valueLength + 1)

    const r = await scrub(source(word))
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain(
      `refusing to write the map: the value of __STR__1 is not a name (1 to ${MAP_LIMITS.valueLength} characters, no control character or line break), so nothing was written.`
    )
    expect(r.out).toBe('')
    expect(r.err).not.toContain('aaaaaaaa')
    expect(readFileSync(mapPath(), 'utf8')).toBe(before)
    expect(existsSync(mapPath())).toBe(true)
  })
})
