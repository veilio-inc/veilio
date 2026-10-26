import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { readCredential, writeCredential } from '../src/credential.js'

/**
 * Signing in again keeps the chosen project, but only for the same account
 * on the same instance (spec 052, founder decision 2026-10-25). Anything else
 * gets a fresh choice, and that is said on stderr: otherwise a second sign-in
 * silently goes back to every project's team maps.
 */

const INSTANCE = 'https://veilio.test'
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-login-project-'))
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/api/auth/login')
      return new Response(
        JSON.stringify({ token: 'new-token', user: { email: 'me@example.test' } }),
        {
          status: 200,
        }
      )
    return new Response(JSON.stringify({ personalMaps: [], teamMaps: [], plan: 'team' }), {
      status: 200,
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

async function login(): Promise<{ code: number; err: string }> {
  let err = ''
  const code = await main(['login', '--instance', INSTANCE], {
    cwd: home,
    home,
    stdin: async () => '',
    stdout: () => undefined,
    stderr: (t) => (err += t),
    prompt: async () => 'me@example.test',
    password: async () => 'CorrectHorseBattery123',
  })
  return { code, err }
}

describe('login and the chosen project', () => {
  it('the same account on the same instance keeps it, silently', async () => {
    writeCredential(
      { token: 'old', account: 'me@example.test', instance: INSTANCE, project: 'p-tools' },
      home
    )
    const r = await login()
    expect(r.code, r.err).toBe(0)
    expect(readCredential(home)).toMatchObject({ token: 'new-token', project: 'p-tools' })
    expect(r.err).not.toMatch(/project/)
  })

  it('another account clears it, and says so', async () => {
    writeCredential(
      { token: 'old', account: 'ada@example.test', instance: INSTANCE, project: 'p-tools' },
      home
    )
    const r = await login()
    expect(r.code, r.err).toBe(0)
    expect(readCredential(home)?.project).toBeUndefined()
    expect(r.err).toMatch(
      /project p-tools was chosen for ada@example\.test on https:\/\/veilio\.test/
    )
    expect(r.err).toContain('`veilio projects use <name>`')
  })

  it('another instance clears it, and says so', async () => {
    writeCredential(
      {
        token: 'old',
        account: 'me@example.test',
        instance: 'https://other.test',
        project: 'p-tools',
      },
      home
    )
    const r = await login()
    expect(readCredential(home)?.project).toBeUndefined()
    expect(r.err).toMatch(
      /project p-tools was chosen for me@example\.test on https:\/\/other\.test/
    )
  })

  it('no project before: nothing to keep, nothing said', async () => {
    writeCredential({ token: 'old', account: 'me@example.test', instance: INSTANCE }, home)
    const r = await login()
    expect(readCredential(home)?.project).toBeUndefined()
    expect(r.err).not.toMatch(/project/)
  })
})
