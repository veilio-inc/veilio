import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Run the built binary the way a user runs it.
 *
 * Every other test in this package calls `main()` directly, which is fast and
 * covers the behaviour — but it means the branch deciding whether `main()` runs
 * AT ALL had never been executed by anything. It was wrong, and it was wrong in
 * the worst available direction: `npm i -g @veilio-inc/cli && veilio --version`
 * printed nothing and exited 0. Installed fine, did nothing, said nothing.
 *
 * The cause was that npm installs a binary as a SYMLINK into node_modules/.bin,
 * so `process.argv[1]` is the link and `import.meta.url` is its target. The
 * guard compared them as strings. Nothing here could catch that without
 * executing the file through a symlink, so that is what this does.
 */
const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js')

function run(bin: string, args: string[], input?: string): string {
  return execFileSync(bin, args, { input: input ?? '', encoding: 'utf8' })
}

describe('the binary, executed as a binary', () => {
  beforeAll(() => {
    // Fail rather than skip. A skipped test on a missing build reports green on
    // exactly the run where nothing was built, which is the state this file
    // exists to refuse.
    expect(
      existsSync(DIST),
      `${DIST} is missing — run \`npm run build\` first. This suite tests the built artifact.`
    ).toBe(true)
  })

  it('runs when invoked by its real path', () => {
    expect(run(process.execPath, [DIST, '--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('runs when invoked through a symlink, as npm installs it', () => {
    // The regression. node_modules/.bin/veilio is a symlink; before the fix this
    // produced an empty string and exit 0.
    const dir = mkdtempSync(join(tmpdir(), 'veilio-bin-'))
    const link = join(dir, 'veilio')
    symlinkSync(DIST, link)
    expect(run(process.execPath, [link, '--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('does real work through the symlink, not just --version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veilio-bin-'))
    const link = join(dir, 'veilio')
    symlinkSync(DIST, link)
    const out = run(process.execPath, [link, 'scrub'], 'class PaymentService { charge(id) {} }')
    expect(out).toContain('__CLS__1')
    expect(out).not.toContain('PaymentService')
  })

  it('reads BOTH the email and password prompts when stdin is piped in one shot', () => {
    // `login` reads two lines in sequence (email, then password) via two
    // calls to the same prompt helper. A scripted, non-interactive caller —
    // exactly what `readSecret`'s own doc comment says is supported ("what a
    // scripted `echo pw | veilio login` needs") — typically delivers both
    // lines in a SINGLE write before closing stdin, which is exactly what
    // `input` below does.
    //
    // The regression: each prompt used to open its own `readline.Interface`
    // and close it after one line. When both lines arrive in one chunk, the
    // first interface reads its buffered password line under the hood too,
    // then discards it on close — the second interface attaches to an
    // already-ended stream and its `question()` never gets a 'line' to
    // answer. Nothing else keeps the event loop alive, so the process just
    // exits 0 having never attempted the network request at all: a silent,
    // false "success" that did nothing. Point at an unreachable instance so
    // a FIXED CLI fails fast with a real connection error (proving it read
    // the password and tried) instead of either exiting 0 immediately (the
    // bug) or hanging (a worse regression of the same bug).
    const result = spawnSync(
      process.execPath,
      [DIST, 'login', '--instance', 'http://localhost:1'],
      { input: 'someone@example.com\nhunter2\n', encoding: 'utf8', timeout: 10_000 }
    )
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).not.toBe(0)
    expect(result.stderr).not.toMatch(/no password given/)
    expect(result.stdout).not.toMatch(/Signed in/)
  })

  it('survives a path with a space in it', () => {
    // `file://${argv[1]}` also broke here: a space needs percent-encoding, so
    // the comparison failed for anyone whose npm prefix contains one — which on
    // macOS and Windows is ordinary.
    const dir = mkdtempSync(join(tmpdir(), 'veilio bin '))
    const link = join(dir, 'veilio')
    symlinkSync(DIST, link)
    expect(run(process.execPath, [link, '--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
