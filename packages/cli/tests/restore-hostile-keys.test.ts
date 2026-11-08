import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE } from '../src/store.js'
import { ALIASES_FILE } from '../src/reservations.js'

/**
 * Security audit: restore built a RegExp from every key map.json and
 * aliases.json disagree on, unescaped. A planted key `(x+x+)+y` froze
 * restore (catastrophic backtracking) and `(` threw. Only placeholder-shaped
 * keys are read from either file; the rest are dropped, and counted.
 */

let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-hk-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-hk-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(cwd, STORE_DIR), { recursive: true })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function run(
  argv: string[],
  stdin: string
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdinBytes: async function* () {
      yield Buffer.from(stdin)
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => '',
  }
  return { code: await main(argv, io), out, err }
}

function plant(map: Record<string, string>, aliases: Record<string, string>): void {
  writeFileSync(join(cwd, STORE_DIR, STORE_FILE), JSON.stringify({ map }))
  writeFileSync(join(cwd, STORE_DIR, ALIASES_FILE), JSON.stringify({ version: 1, aliases }))
}

describe('restore with keys that are not placeholders', () => {
  it('a backtracking key in both files: restore completes fast and still restores', async () => {
    plant({ '(x+x+)+y': 'a', __VAR__1: 'amount' }, { '(x+x+)+y': 'b' })
    const started = Date.now()
    const res = await run(['restore'], `${'x'.repeat(29)} __VAR__1\n`)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toContain(`${'x'.repeat(29)} amount`)
    expect(res.err).toMatch(/ignored 2 entries/)
  })

  it('an invalid pattern as a key does not throw', async () => {
    plant({ '(': 'a', '[': 'b', __VAR__1: 'amount' }, { '(': 'c', '[': 'd' })
    const res = await run(['restore'], 'x = __VAR__1\n')
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toContain('x = amount')
  })
})
