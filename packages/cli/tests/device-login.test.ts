import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'

/**
 * Signing in by asking a browser (spec 046).
 *
 * `POST /api/auth/login` requires a CAPTCHA token this process cannot produce,
 * and `TURNSTILE_SECRET_KEY` is required in production — so before this, the
 * published CLI could not sign in to a production-shaped instance at all. The
 * reproduction was a real one: `veilio login` against staging answered
 * "CAPTCHA verification failed. Please try again."
 *
 * The property most of these guard: a refusal leaves no credential on disk.
 * Half a sign-in is worse than none, because every later command then fails
 * with something that reads like a wrong password.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

const INSTANCE = 'https://veilio.test'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-dev-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-dev-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const credentialPath = (): string => join(home, '.veilio', 'credential.json')

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const START = {
  device_code: 'a'.repeat(43),
  user_code: 'HWBG-ZJ54',
  verification_uri: `${INSTANCE}/device`,
  verification_uri_complete: `${INSTANCE}/device?code=HWBG-ZJ54`,
  // Short, so an expiry test does not have to wait.
  expires_in: 1,
  interval: 1,
}

/**
 * Answer the device endpoints. `tokenResponses` is consumed one poll at a time,
 * so a test can say "pending, pending, then granted".
 */
function serve(opts: {
  start?: Response
  tokenResponses?: Response[]
  login?: Response
  me?: Response
  expiresIn?: number
}): void {
  const polls = [...(opts.tokenResponses ?? [])]
  fetchMock.mockImplementation(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/api/auth/login')) {
      return opts.login ?? json(200, { token: 'password-session' })
    }
    if (u.endsWith('/api/auth/device/code')) {
      return opts.start ?? json(201, { ...START, expires_in: opts.expiresIn ?? START.expires_in })
    }
    if (u.endsWith('/api/auth/device/token')) {
      return polls.shift() ?? json(400, { error: 'authorization_pending' })
    }
    if (u.endsWith('/api/auth/me')) {
      return opts.me ?? json(200, { user: { email: 'dev@example.test' } })
    }
    // `runLogin` probes entitlement after a password sign-in: a 200 here is
    // what "this plan includes the terminal" looks like. Left out of the first
    // draft of this harness, which made the password path exit 2 and read as a
    // fallback bug.
    if (u.endsWith('/api/maps')) {
      return json(200, { personalMaps: [], teamMaps: [], team: null, plan: 'pro' })
    }
    return json(404, { error: `unexpected ${u}` })
  })
}

interface Run {
  code: number
  out: string
  err: string
}

async function run(argv: string[], answers: string[] = []): Promise<Run> {
  let out = ''
  let err = ''
  const queue = [...answers]
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => queue.shift() ?? '',
    password: async () => queue.shift() ?? '',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

describe('login --device', () => {
  it('prints the code and the page, and signs in once approved', async () => {
    serve({ tokenResponses: [json(200, { token: 'device-session' })] })

    const { code, err, out } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_OK)
    // The instructions go to stderr, so `veilio login` still composes in a pipe.
    expect(err).toContain('HWBG-ZJ54')
    expect(err).toContain(`${INSTANCE}/device?code=HWBG-ZJ54`)
    expect(out).toContain('dev@example.test')

    const stored = JSON.parse(readFileSync(credentialPath(), 'utf8')) as {
      token: string
      account: string
    }
    expect(stored.token).toBe('device-session')
    expect(stored.account).toBe('dev@example.test')
  })

  it('never asks for a password', async () => {
    // Nothing about the account is typed here, which is why there is nothing
    // for a CAPTCHA to protect.
    serve({ tokenResponses: [json(200, { token: 'device-session' })] })
    let askedFor = ''
    const io: Io = {
      cwd,
      home,
      stdin: async () => '',
      stdout: () => {},
      stderr: () => {},
      prompt: async (q) => {
        askedFor += q
        return ''
      },
      password: async (q) => {
        askedFor += q
        return ''
      },
    }
    await main(['login', '--instance', INSTANCE, '--device'], io)
    expect(askedFor).toBe('')
  })

  it('keeps polling while nobody has approved yet', async () => {
    serve({
      expiresIn: 60,
      tokenResponses: [
        json(400, { error: 'authorization_pending' }),
        json(400, { error: 'authorization_pending' }),
        json(200, { token: 'device-session' }),
      ],
    })

    const { code } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_OK)
    const polls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/device/token'))
    expect(polls).toHaveLength(3)
  })

  it('backs off when told to slow down, rather than giving up', async () => {
    serve({
      expiresIn: 60,
      tokenResponses: [json(429, { error: 'slow_down' }), json(200, { token: 'device-session' })],
    })

    const { code } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_OK)
  })

  it('stops and explains when the request is declined', async () => {
    serve({ expiresIn: 60, tokenResponses: [json(400, { error: 'access_denied' })] })

    const { code, err } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/declined/i)
    // The same answer covers "the approving session was revoked", so the
    // message has to name that possibility or it reads as a lie.
    expect(err).toMatch(/revoked/i)
    expect(existsSync(credentialPath())).toBe(false)
  })

  it('stops and explains when the code has already been used or expired', async () => {
    serve({ expiresIn: 60, tokenResponses: [json(400, { error: 'expired_token' })] })

    const { code, err } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/no longer valid/i)
    expect(existsSync(credentialPath())).toBe(false)
  })

  it('gives up when the code expires unapproved, and writes nothing', async () => {
    serve({ expiresIn: 0, tokenResponses: [] })

    const { code, err } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/expired before it was approved/i)
    expect(existsSync(credentialPath())).toBe(false)
  })

  it('writes nothing when the instance will not start a request', async () => {
    serve({ start: json(500, { error: 'boom' }) })

    const { code } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_ERROR)
    expect(existsSync(credentialPath())).toBe(false)
  })

  it('refuses to store a credential it cannot label with an account', async () => {
    // The account on the credential is what matches an unlocked team key to the
    // session later. A credential with no account would read as signed in and
    // fail everything that needs the team key.
    serve({
      tokenResponses: [json(200, { token: 'device-session' })],
      me: json(200, { user: {} }),
    })

    const { code, err } = await run(['login', '--instance', INSTANCE, '--device'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/which account/i)
    expect(existsSync(credentialPath())).toBe(false)
  })
})

describe('falling back from the password path', () => {
  it('switches to the browser when the instance demands a CAPTCHA', async () => {
    // The reproduction from the release blocker: this is what staging answered.
    serve({
      login: json(403, { error: 'CAPTCHA verification failed. Please try again.' }),
      tokenResponses: [json(200, { token: 'device-session' })],
    })

    const { code, err } = await run(
      ['login', '--instance', INSTANCE],
      ['dev@example.test', 'a-password']
    )

    expect(code).toBe(EXIT_OK)
    expect(err).toMatch(/browser check that a terminal cannot do/i)
    expect(err).toContain('HWBG-ZJ54')
  })

  it('does not report a CAPTCHA failure to somebody who was never shown one', async () => {
    serve({
      login: json(403, { error: 'CAPTCHA verification failed. Please try again.' }),
      tokenResponses: [json(200, { token: 'device-session' })],
    })

    const { err } = await run(['login', '--instance', INSTANCE], ['dev@example.test', 'pw'])

    expect(err).not.toMatch(/CAPTCHA verification failed/)
  })

  it('still signs in with a password where that works', async () => {
    // Removing the password path would break every existing install, and it is
    // correct on an instance with neither Turnstile nor an SSO requirement.
    serve({ login: json(200, { token: 'password-session' }) })

    const { code } = await run(
      ['login', '--instance', INSTANCE],
      ['dev@example.test', 'a-password']
    )

    expect(code).toBe(EXIT_OK)
    const stored = JSON.parse(readFileSync(credentialPath(), 'utf8')) as { token: string }
    expect(stored.token).toBe('password-session')
    // No device request was made at all.
    // No device request was made at all.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/device'))).toHaveLength(0)
  })

  it('does not fall back on an ordinary wrong password', async () => {
    // Falling back here would turn "you typed the wrong password" into a
    // browser dance that cannot fix it.
    serve({ login: json(401, { error: 'Invalid email or password' }) })

    const { code, err } = await run(
      ['login', '--instance', INSTANCE],
      ['dev@example.test', 'wrong']
    )

    expect(code).toBe(EXIT_ERROR)
    expect(err).not.toContain('HWBG-ZJ54')
    // No device request was made at all.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/device'))).toHaveLength(0)
  })
})
