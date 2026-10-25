import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'

/**
 * The Community Edition contract (spec 011 T034, spec 052 FR-022 to FR-024).
 *
 * The Community Edition has no server, so nobody using it is ever signed in.
 * What it must do with no account is pinned here as one table, so a change
 * that breaks it fails a test rather than a user:
 *
 *  - everything that works offline works, and makes no network call;
 *  - every Veilio Cloud command refuses with one sentence naming the way in;
 *  - nothing quietly does less than it was asked.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-ce-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-ce-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(
    join(cwd, 'src', 'ledger.ts'),
    'export class LedgerService { settle(total: number) { return total } }\n'
  )
  writeFileSync(join(cwd, 'src', 'creds.ts'), 'const awsKey = "AKIAIOSFODNN7EXAMPLE"\n')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function run(
  argv: string[],
  stdin = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => '',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

describe('offline commands work with no account, and make no request', () => {
  it('scrub masks and restore brings it back', async () => {
    const masked = await run(['scrub', 'src/ledger.ts'])
    expect(masked.code).toBe(EXIT_OK)
    expect(masked.out).toContain('__CLS__1')
    const restored = await run(['restore'], masked.out)
    expect(restored.code).toBe(EXIT_OK)
    expect(restored.out).toContain('LedgerService')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('scan finds a credential and exits 1', async () => {
    const r = await run(['scan', 'src/creds.ts'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/AWS access key/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('map shows the local map', async () => {
    await run(['scrub', 'src/ledger.ts'])
    const r = await run(['map', '--json'])
    expect(r.code).toBe(EXIT_OK)
    expect(JSON.parse(r.out)).toMatchObject({ __CLS__1: 'LedgerService' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('every Veilio Cloud command refuses with the way in', () => {
  it.each([
    [['maps', 'list']],
    [['maps', 'push', 'billing']],
    [['maps', 'push', 'billing', '--team']],
    [['maps', 'pull', 'map-1']],
    [['maps', 'rm', 'map-1']],
    [['team', 'unlock']],
    [['rules', 'pull']],
  ])('%j answers "not signed in", names veilio login, and writes nothing', async (argv) => {
    const r = await run(argv)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/not signed in/i)
    expect(r.err).toMatch(/veilio login/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [['whoami'], /not signed in/i],
    [['logout'], /not signed in/i],
    [['team', 'lock'], /no team keys were unlocked/i],
  ])('%j answers politely with exit 0', async (argv, answer) => {
    const r = await run(argv)
    expect(r.code).toBe(EXIT_OK)
    expect(r.out + r.err).toMatch(answer)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('nothing quietly does less than it was asked', () => {
  it('scrub --team says it numbered locally because nobody is signed in', async () => {
    const r = await run(['scrub', '--team', 'src/ledger.ts'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toContain('__CLS__1')
    expect(r.err).toMatch(/--team/)
    expect(r.err).toMatch(/veilio login/)
  })
})
