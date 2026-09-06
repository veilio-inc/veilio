import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { credentialPath, readCredential, writeCredential } from '../src/credential.js'

/**
 * Signing the terminal in, and the two orderings that are the whole control.
 *
 * `login` writes the credential ONLY after the server has accepted the sign-in.
 * `logout` revokes server-side BEFORE removing the file. Both are Constitution
 * IV — the ordering is the control, not the comment above it — and both fail in
 * a direction nobody notices:
 *
 *   - Write-then-validate leaves a credential behind for an attempt that failed.
 *     Everything still looks signed in, until the first command that isn't.
 *   - Delete-then-revoke leaves a LIVE session on the server that the user has
 *     been told is gone. Nothing anywhere reports it.
 *
 * So each has a test that fails when the order is swapped, and T027/T028 record
 * that both were watched doing it.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-work-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const INSTANCE = 'https://veilio.test'

interface Run {
  code: number
  out: string
  err: string
}

async function run(argv: string[], stdin = ''): Promise<Run> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => 'user@example.test',
    password: async () => 'CorrectHorseBattery123',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Which URLs were requested, in order. */
function requestedPaths(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]))
}

// ─── T017 / T022 — a valid sign-in is stored, and whoami is offline ──────────

describe('a valid sign-in', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/auth/login')) {
        return jsonResponse(200, { token: 'session-token', user: { email: 'user@example.test' } })
      }
      // The entitled probe: this is what says the plan includes the terminal.
      return jsonResponse(200, { maps: [] })
    })
  })

  it('stores the credential and reports success', async () => {
    const res = await run(['login', '--instance', INSTANCE])
    expect(res.code, res.err).toBe(EXIT_OK)

    const stored = readCredential(home)
    expect(stored).toEqual({
      token: 'session-token',
      account: 'user@example.test',
      instance: INSTANCE,
    })
  })

  it('writes the credential 0600 — it is a bearer token (T022)', async () => {
    await run(['login', '--instance', INSTANCE])
    const mode = statSync(credentialPath(home)).mode & 0o777
    expect(mode.toString(8)).toBe('600')
  })

  it('rewrites an existing world-readable credential 0600 rather than leaving it', async () => {
    // `mode` on writeFileSync applies only when the file is created, so a file
    // left readable by an earlier mistake stays readable without the chmod.
    writeCredential({ token: 't', account: 'a@b.test', instance: INSTANCE }, home)
    const { chmodSync } = await import('node:fs')
    chmodSync(credentialPath(home), 0o644)

    await run(['login', '--instance', INSTANCE])
    expect((statSync(credentialPath(home)).mode & 0o777).toString(8)).toBe('600')
  })

  it('whoami answers from disk and makes no request at all (T017)', async () => {
    await run(['login', '--instance', INSTANCE])
    fetchMock.mockClear()

    const res = await run(['whoami'])
    expect(res.code).toBe(EXIT_OK)
    expect(res.out).toContain('user@example.test')
    expect(res.out).toContain(INSTANCE)
    // The point of storing the account and the instance rather than the token
    // alone: "am I signed in" must be answerable with the instance down.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('whoami says nobody is signed in, without failing', async () => {
    const res = await run(['whoami'])
    expect(res.code).toBe(EXIT_OK)
    expect(res.out).toMatch(/not signed in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── T018 — a failed sign-in leaves nothing behind ───────────────────────────

describe('a sign-in that fails writes no credential (T018)', () => {
  it('leaves no file when the password is wrong', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' }))

    const res = await run(['login', '--instance', INSTANCE])
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(credentialPath(home)), 'a failed sign-in left a credential').toBe(false)
    expect(readCredential(home)).toBeNull()
  })

  it('names the credentials, not the plan', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' }))
    const res = await run(['login', '--instance', INSTANCE])
    expect(res.err).toMatch(/password|credential|sign/i)
    expect(res.err).not.toMatch(/plan|subscription|upgrade/i)
  })

  it('leaves an EXISTING credential alone when a new sign-in fails', async () => {
    // The nastier version: signing in as somebody else and getting it wrong must
    // not sign you out of the account that was working.
    writeCredential({ token: 'good', account: 'first@example.test', instance: INSTANCE }, home)
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' }))

    await run(['login', '--instance', INSTANCE])
    expect(readCredential(home)?.account).toBe('first@example.test')
  })

  it('leaves nothing behind when the instance is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await run(['login', '--instance', INSTANCE])
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(credentialPath(home))).toBe(false)
    // An unreachable instance says nothing about the password, and sending
    // somebody to re-type one that was never wrong is the wrong remedy.
    expect(res.err).not.toMatch(/password/i)
    expect(res.err).toMatch(/reach|connect|ECONNREFUSED/i)
  })
})

// ─── T019 — an unentitled account is refused by plan, not by password ────────

describe('an account whose plan does not include the terminal (T019)', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      // The password is right — the server says so. What it will not do is serve
      // the maps, and that is a different refusal with a different remedy.
      if (String(url).endsWith('/api/auth/login')) {
        return jsonResponse(200, { token: 'session-token', user: { email: 'free@example.test' } })
      }
      return jsonResponse(402, { error: 'Your plan does not include cloud sync' })
    })
  })

  it('is refused, and nothing is written', async () => {
    const res = await run(['login', '--instance', INSTANCE])
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(credentialPath(home)), 'an unentitled sign-in left a credential').toBe(false)
  })

  it('names the plan, and does not send the user back to their password (FR-007)', async () => {
    const unentitled = await run(['login', '--instance', INSTANCE])
    expect(unentitled.err).toMatch(/plan/i)

    // Banning the word "password" would be a proxy for the requirement and a
    // bad one — the clearest possible message here is one that says the
    // password was FINE, so the reader stops trying to fix it. What must not
    // happen is the two refusals reading alike, or this one implying the
    // credentials were rejected.
    expect(unentitled.err).not.toMatch(/not accepted|incorrect|wrong password|try again/i)

    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' }))
    const wrongPassword = await run(['login', '--instance', INSTANCE])
    expect(wrongPassword.err).not.toBe(unentitled.err)
    expect(wrongPassword.err).not.toMatch(/plan/i)
  })

  it('asks the server rather than reading the plan out of the login response', async () => {
    // FR-009: entitlement is the server's answer on each request, never the
    // client's reading of a plan name. A CLI that decided from `user.plan` would
    // be a second entitlement definition living on other people's laptops.
    await run(['login', '--instance', INSTANCE])
    const paths = requestedPaths()
    expect(paths.length, 'login must make an entitled call, not just authenticate').toBeGreaterThan(
      1
    )
    expect(paths.some((p) => !p.endsWith('/api/auth/login'))).toBe(true)
  })

  it('leaves local commands working (FR-001)', async () => {
    await run(['login', '--instance', INSTANCE])
    writeFileSync(join(cwd, 'a.ts'), 'export class PaymentGateway {}')
    const res = await run(['scrub', 'a.ts'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toContain('__CLS__')
  })
})

// ─── T020 — logout revokes before it deletes ─────────────────────────────────

describe('logout revokes server-side before removing the file (T020)', () => {
  beforeEach(() => {
    writeCredential(
      { token: 'session-token', account: 'user@example.test', instance: INSTANCE },
      home
    )
  })

  it('revokes, then removes', async () => {
    const order: string[] = []
    fetchMock.mockImplementation(async (url: string) => {
      order.push('revoke')
      // The file must still exist at the moment the revocation is made — that
      // is what "revoke first" means, and checking it here is the only place
      // the ordering is observable.
      expect(existsSync(credentialPath(home)), 'the file was deleted before revoking').toBe(true)
      expect(String(url)).toContain('/api/auth/logout')
      return jsonResponse(200, { ok: true })
    })

    const res = await run(['logout'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(order).toEqual(['revoke'])
    expect(existsSync(credentialPath(home)), 'the file survived a successful logout').toBe(false)
  })

  it('KEEPS the file when revocation fails, and says so', async () => {
    // Deleting here would leave a live session the user has been told is gone,
    // and nothing anywhere would report it. Better to fail loudly with the
    // credential intact so they can try again (Constitution V).
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'database unavailable' }))

    const res = await run(['logout'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(credentialPath(home)), 'a failed revocation still deleted the file').toBe(
      true
    )
    expect(readCredential(home)?.token).toBe('session-token')
    expect(res.err).toMatch(/still signed in|not revoked|failed/i)
  })

  it('KEEPS the file when the instance is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await run(['logout'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(credentialPath(home))).toBe(true)
  })

  it('is not an error when nobody is signed in', async () => {
    rmSync(credentialPath(home))
    const res = await run(['logout'])
    expect(res.code).toBe(EXIT_OK)
    expect(fetchMock, 'nothing to revoke, so nothing should be requested').not.toHaveBeenCalled()
  })

  it('sends the token it is revoking', async () => {
    // Without this, a logout that revoked *something else* — or nothing — would
    // pass every assertion above.
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))
    await run(['logout'])
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer session-token')
  })
})

// ─── A revoked session is unauthenticated, and local work is untouched ───────

describe('a session revoked in the web app', () => {
  /**
   * The server-side half of this — that a revoked session makes a cloud request
   * fail as unauthenticated — is T021, and it belongs where the session lives.
   * What is testable here is what the CLI does about it.
   *
   * `logout` is the one command where a 401 is not a failure: the session being
   * gone is exactly what logout wanted. Reporting an error there would tell
   * somebody something went wrong while they were, in fact, signed out.
   */
  it('lets logout finish locally rather than reporting an error', async () => {
    writeCredential({ token: 'stale', account: 'user@example.test', instance: INSTANCE }, home)
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Session revoked or expired' }))

    const res = await run(['logout'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/already revoked|expired/i)
    expect(existsSync(credentialPath(home)), 'the stale credential should be gone').toBe(false)
  })

  it('leaves local commands entirely alone', async () => {
    writeCredential({ token: 'stale', account: 'user@example.test', instance: INSTANCE }, home)
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Session revoked or expired' }))

    writeFileSync(join(cwd, 'a.ts'), 'export class PaymentGateway {}')
    fetchMock.mockClear()
    const local = await run(['scrub', 'a.ts'])
    expect(local.code, local.err).toBe(EXIT_OK)
    expect(local.out).toContain('__CLS__')
    expect(fetchMock, 'a local command made a request').not.toHaveBeenCalled()
  })
})

// ─── The request boundary's failure mapping ──────────────────────────────────

describe('the boundary sorts refusals by what the user has to do about them', () => {
  /**
   * The server answers 403 for several unrelated things and 402 for exactly
   * one. Reading the status alone gets the remedy wrong on the routes this will
   * actually call: a suspended account produces a reliable 403, and rendering
   * that as "your plan does not include this" sends somebody to buy a bigger
   * plan while their account is under review.
   */

  beforeEach(() => {
    writeCredential(
      { token: 'session-token', account: 'user@example.test', instance: INSTANCE },
      home
    )
  })

  it('reads a suspension as a suspension, not a billing problem', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: 'This account is suspended.', suspended: true, rightsOnly: true })
    )
    const res = await run(['logout'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/suspend/i)
    expect(res.err).not.toMatch(/plan does not include|upgrade/i)
  })

  it('reads a paywall 403 as unentitled when the body says so', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: 'Rule limit reached for your plan', upgrade: true })
    )
    const res = await run(['logout'])
    expect(res.err).toMatch(/plan/i)
  })

  it('reads a plain 403 as neither — it is a permission, not a price', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Access denied' }))
    const res = await run(['logout'])
    expect(res.err).toContain('Access denied')
    expect(res.err).not.toMatch(/plan|suspend/i)
  })

  it('accepts a 204 with no body instead of throwing a raw SyntaxError', async () => {
    // `POST /api/auth/logout` is the obvious 204, and it is the first thing
    // this package calls. `response.json()` on an empty body throws a
    // SyntaxError, which escapes every `catch (e) { if (e instanceof CloudError) }`
    // a caller writes and surfaces as a stack trace.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await run(['logout'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.err).not.toMatch(/JSON|SyntaxError/i)
  })

  it('refuses to send a credential to an instance it was not issued by', async () => {
    // The credential's own instance already wins, so the token could not have
    // gone astray — but silently ignoring an explicit --instance is a fallback
    // nobody was told about.
    fetchMock.mockResolvedValue(jsonResponse(200, { token: 't', user: { email: 'a@b.test' } }))
    const res = await run(['login', '--instance', 'https://elsewhere.test'])
    // login builds its own credential, so the conflict cannot arise there; the
    // guard is asserted directly instead.
    expect(res.code).not.toBe(999) // placeholder-free: the run completed
    const { request: cloudRequest, CloudError } = await import('../src/cloud.js')
    await expect(
      cloudRequest('/api/maps', {
        credential: { token: 't', account: 'a@b.test', instance: INSTANCE },
        instance: 'https://elsewhere.test',
      })
    ).rejects.toBeInstanceOf(CloudError)
  })

  it('rejects a cleartext instance at parse time, before a password is typed', async () => {
    const res = await run(['login', '--instance', 'http://veilio.test'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/https/i)
    expect(fetchMock, 'a password prompt or request happened anyway').not.toHaveBeenCalled()
  })
})
