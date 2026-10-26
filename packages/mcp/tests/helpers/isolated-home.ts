// A HOME of this test file's own. The server reads the credential, the cached
// rules and the team keys from the home directory, so on a machine where
// someone is signed in a test that forgot this saw that person's account (the
// cloud tools listed, its Cloud asked). Each file that calls the server
// without an injected `ctx.home` calls this once, at the top level.
//
// `os.homedir()` reads HOME (USERPROFILE on Windows) on every call, so setting
// both before the tests run covers every read, and a child process spawned
// with the parent's environment inherits it.
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { readCredential } from '@veilio-inc/cli/credential'

export function isolateHome(): () => string {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'veilio-home-'))
    process.env.HOME = dir
    process.env.USERPROFILE = dir
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  // Fails when the isolation above is taken out, on any machine: on CI the
  // home directory is the runner's, never a fresh temporary one.
  it('runs with a home directory of its own, where nobody is signed in', () => {
    expect(dir).not.toBe('')
    expect(homedir()).toBe(dir)
    expect(readCredential()).toBeNull()
  })
  return () => dir
}
