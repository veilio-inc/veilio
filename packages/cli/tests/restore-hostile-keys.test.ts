import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential } from '../src/credential.js'
import { STORE_DIR, STORE_FILE, loadMap } from '../src/store.js'
import { ALIASES_FILE } from '../src/reservations.js'

/**
 * Security audit: restore built a RegExp from every key map.json and
 * aliases.json disagree on, unescaped. A planted key `(x+x+)+y` froze
 * restore (catastrophic backtracking) and `(` threw. Only placeholder-shaped
 * keys are read from either file; the rest are dropped, and counted.
 *
 * 2026-11-16: the expectation for map.json changed. A map file holding a key
 * that is not a placeholder is no longer read with that key dropped: the file
 * is refused, naming the key, by every command that reads it (restore, scrub,
 * a push). Dropping it left masking and pushing to use the file as it was,
 * and a pushed map with such a key is one no reader opens. aliases.json keeps
 * drop-and-count.
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

const mapFile = (): string => join(cwd, STORE_DIR, STORE_FILE)
const refusal = (key: string): string =>
  `map file at ${mapFile()} holds a key that is not a placeholder ("${key}"), so the file is not used. Remove that entry from the file.`

describe('a map file with a key that is not a placeholder is not used', () => {
  it.each([
    ['a backtracking pattern', '(x+x+)+y'],
    ['an unclosed group', '('],
    ['a word', 'fetch'],
    ['the empty key', ''],
  ])('%s: restore refuses the file, naming the key, and restores nothing', async (_, key) => {
    plant({ [key]: 'a', __VAR__1: 'amount' }, {})
    const started = Date.now()
    const res = await run(['restore'], `${'x'.repeat(29)} fetch __VAR__1\n`)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.code).not.toBe(EXIT_OK)
    expect(res.err).toContain(refusal(key))
    expect(res.out).toBe('')
  })

  it('scrub refuses it: nothing is masked with it, and the file is left as it was', async () => {
    plant({ fetch: 'send', __VAR__1: 'amount' }, {})
    const before = readFileSync(mapFile(), 'utf8')
    writeFileSync(join(cwd, 'ledger.ts'), 'const settleLedger = 1\n')
    const res = await run(['scrub', 'ledger.ts'], '')
    expect(res.code).not.toBe(EXIT_OK)
    expect(res.err).toContain(refusal('fetch'))
    expect(res.out).toBe('')
    expect(readFileSync(mapFile(), 'utf8')).toBe(before)
  })

  it('a push refuses it before any request', async () => {
    plant({ fetch: 'send', __VAR__1: 'amount' }, {})
    writeCredential({ token: 'tok', account: 'a@b.test', instance: 'https://veilio.test' }, home)
    const sent: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      sent.push(String(url))
      return new Response('{}', { status: 500 })
    })
    try {
      for (const argv of [
        ['maps', 'push', 'mine'],
        ['maps', 'push', '--team', 'mine'],
      ]) {
        const res = await run(argv, '')
        expect(res.code).not.toBe(EXIT_OK)
        expect(res.err).toContain(refusal('fetch'))
      }
      expect(sent).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the key is shown without control characters, 60 characters at most', async () => {
    const key = `\u001b[2J${'k'.repeat(100)}`
    plant({ [key]: 'a' }, {})
    const res = await run(['restore'], 'x\n')
    expect(res.err).toContain(refusal(`[2J${'k'.repeat(57)}`))
    expect(res.err).not.toContain('\u001b')
  })

  it('a map file of every family of placeholder the tools write is read', () => {
    const map = {
      __CLS__1: 'PaymentGateway',
      __FN__2: 'chargeCard',
      __VAR__3: 'amountDue',
      __PKG__4: 'billing-core',
      __STR__5: 'ledger',
      __MANUAL__6: 'Jan Kowalski',
      __LOCAL_K7Q2XA_VAR__7: 'localTotal',
      __H_0123456789ABCDEF__8: 'hashedBase',
      __CODENAME__: 'phoenix',
      __CODENAME__9: 'griffin',
      __IBAN__10: 'GB82 WEST 1234 5698 7654 32',
      __P11__: 'legacyName',
    }
    plant(map, {})
    expect(loadMap(mapFile())).toEqual(map)
  })
})

describe('aliases.json with keys that are not placeholders', () => {
  it('they are dropped and counted, and restore goes on', async () => {
    plant({ __VAR__1: 'amount' }, { '(x+x+)+y': 'b', '(': 'c', __VAR__2: 'total' })
    const started = Date.now()
    const res = await run(['restore'], `${'x'.repeat(29)} __VAR__1 __VAR__2\n`)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toContain(`${'x'.repeat(29)} amount total`)
    expect(res.err).toContain('ignored 2 entries in aliases.json whose key is not a placeholder.')
  })

  it('one is said as one', async () => {
    plant({ __VAR__1: 'amount' }, { '[': 'd' })
    const res = await run(['restore'], 'x = __VAR__1\n')
    expect(res.out).toContain('x = amount')
    expect(res.err).toContain('ignored 1 entry in aliases.json whose key is not a placeholder.')
  })
})
