import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readTeamUnlock,
  writeTeamUnlock,
  removeTeamUnlock,
  teamUnlockPath,
  expiryFrom,
  DEFAULT_UNLOCK_DAYS,
  type TeamUnlock,
} from '../src/team-unlock.js'

/**
 * The team keys at rest.
 *
 * This file is key material, not a token the server can revoke — whoever holds
 * it can read the team's maps until the keys rotate. So the tests that matter
 * here are the ones about refusing to hand it over: wrong account, wrong
 * instance, expired, damaged.
 *
 * Every refusal reads as "not unlocked" rather than as an error, for the reason
 * `credential.ts` gives: the callers underneath this are local commands that
 * must keep working for someone who never signed in.
 */

const homes: string[] = []
const BINDING = { instance: 'https://veilio.test', account: 'a@example.test' }

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'veilio-unlock-'))
  homes.push(home)
  return home
}

function unlock(over: Partial<TeamUnlock> = {}): TeamUnlock {
  return {
    v: 1,
    instance: BINDING.instance,
    account: BINDING.account,
    teamId: 'team-1',
    expiresAt: expiryFrom(new Date()),
    keys: [{ version: 1, key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }],
    ...over,
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('a round trip', () => {
  it('reads back what was written', async () => {
    const home = freshHome()
    const written = unlock()

    writeTeamUnlock(written, home)

    expect(readTeamUnlock(BINDING, home)).toEqual(written)
  })

  it('writes readable only by this user', () => {
    // This is key material sitting beside a session token, and it gets the same
    // posture the token gets.
    const home = freshHome()

    writeTeamUnlock(unlock(), home)

    expect(statSync(teamUnlockPath(home)).mode & 0o777).toBe(0o600)
  })

  it('tightens the mode of a file that was already too open', () => {
    // `mode` on writeFileSync applies only when the file is created, so
    // re-unlocking over a world-readable file left from an earlier mistake
    // would otherwise keep it world-readable.
    const home = freshHome()
    const path = teamUnlockPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}')
    chmodSync(path, 0o644)

    writeTeamUnlock(unlock(), home)

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('refusing to hand the keys over', () => {
  it('returns null when nothing was ever unlocked', () => {
    expect(readTeamUnlock(BINDING, freshHome())).toBeNull()
  })

  it('refuses an unlock belonging to another account', () => {
    // Two people on one machine, or one account signed out and another in.
    const home = freshHome()
    writeTeamUnlock(unlock({ account: 'someone.else@example.test' }), home)

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('refuses an unlock from another instance', () => {
    // Signed in to a self-hosted instance yesterday, the hosted one today. The
    // leftover file is simply not ours.
    const home = freshHome()
    writeTeamUnlock(unlock({ instance: 'https://self-hosted.test' }), home)

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('refuses an expired unlock', () => {
    const home = freshHome()
    const past = new Date(Date.now() - 1000).toISOString()
    writeTeamUnlock(unlock({ expiresAt: past }), home)

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('treats the expiry as exclusive, so the instant it lapses it is gone', () => {
    const home = freshHome()
    const at = new Date('2026-06-01T12:00:00.000Z')
    writeTeamUnlock(unlock({ expiresAt: at.toISOString() }), home)

    expect(readTeamUnlock(BINDING, home, new Date(at.getTime() - 1))).not.toBeNull()
    expect(readTeamUnlock(BINDING, home, at)).toBeNull()
  })

  it('refuses an unparseable expiry rather than treating it as forever', () => {
    const home = freshHome()
    writeTeamUnlock(unlock({ expiresAt: 'whenever' }), home)

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })
})

describe('a damaged file reads as not unlocked', () => {
  function writeRaw(home: string, contents: string): void {
    const path = teamUnlockPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, { mode: 0o600 })
  }

  it('tolerates invalid JSON', () => {
    const home = freshHome()
    writeRaw(home, '{ not json')

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('tolerates a truncated write', () => {
    const home = freshHome()
    writeRaw(home, JSON.stringify(unlock()).slice(0, 40))

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('refuses a future schema version rather than guessing at it', () => {
    const home = freshHome()
    writeRaw(home, JSON.stringify({ ...unlock(), v: 2 }))

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('refuses an unlock holding no keys', () => {
    const home = freshHome()
    writeRaw(home, JSON.stringify({ ...unlock(), keys: [] }))

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('refuses a malformed key entry', () => {
    const home = freshHome()
    writeRaw(home, JSON.stringify({ ...unlock(), keys: [{ version: 'one', key: '' }] }))

    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })
})

describe('locking', () => {
  it('removes the keys and says it did', () => {
    const home = freshHome()
    writeTeamUnlock(unlock(), home)

    expect(removeTeamUnlock(home)).toBe(true)
    expect(readTeamUnlock(BINDING, home)).toBeNull()
  })

  it('reports that there was nothing to remove, without failing', () => {
    // `team lock` on a machine that never unlocked should say so and exit
    // cleanly, the same way `logout` does.
    expect(removeTeamUnlock(freshHome())).toBe(false)
  })
})

describe('the default lifetime', () => {
  it('is a week, and is what expiryFrom uses when not told otherwise', () => {
    const now = new Date('2026-06-01T00:00:00.000Z')

    const days = (Date.parse(expiryFrom(now)) - now.getTime()) / 86_400_000

    expect(days).toBe(DEFAULT_UNLOCK_DAYS)
    expect(DEFAULT_UNLOCK_DAYS).toBe(7)
  })

  it('can be shortened', () => {
    const now = new Date('2026-06-01T00:00:00.000Z')

    expect(expiryFrom(now, 1)).toBe('2026-06-02T00:00:00.000Z')
  })
})
