import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Start the built server the way an agent starts it.
 *
 * The README's `.mcp.json` runs `npx -y @veilio-inc/mcp`, and npx runs the
 * package's binary through a SYMLINK in node_modules/.bin. The check deciding
 * whether `start()` runs compared `import.meta.url` with `file://${argv[1]}`,
 * so through the link (or from a path with a space, or any Windows path) the
 * two never matched: the server exited 0 without a word and never answered
 * `initialize`. The CLI shipped the same bug and has the same test
 * (packages/cli/tests/binary.test.ts); this one was never ported.
 */
const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const INITIALIZE = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`

function initialize(entry: string): { stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'veilio-mcp-root-'))
  const r = spawnSync(process.execPath, [entry, '--root', root], {
    input: INITIALIZE,
    encoding: 'utf8',
    timeout: 15_000,
    // An empty home: no stored sign-in, so startup never reaches the network.
    env: { ...process.env, HOME: root, USERPROFILE: root },
  })
  return { stdout: r.stdout, stderr: r.stderr }
}

function answersInitialize(entry: string): void {
  const { stdout, stderr } = initialize(entry)
  expect(stderr).toContain('veilio-mcp: serving')
  const reply = JSON.parse(stdout.split('\n')[0]) as {
    id: number
    result?: { serverInfo?: unknown }
  }
  expect(reply.id).toBe(1)
  expect(reply.result?.serverInfo).toBeDefined()
}

describe('the server, started as a binary', () => {
  beforeAll(() => {
    // Fail rather than skip: a skipped test on a missing build reports green on
    // exactly the run where nothing was built.
    expect(
      existsSync(DIST),
      `${DIST} is missing — run \`npm run build\` first. This suite tests the built artifact.`
    ).toBe(true)
  })

  it('answers initialize when started by its real path', () => {
    answersInitialize(DIST)
  })

  it('answers initialize when started through a symlink, as npx and npm bins do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veilio-mcp-bin-'))
    const link = join(dir, 'veilio-mcp')
    symlinkSync(DIST, link)
    answersInitialize(link)
  })

  it('answers initialize from a path containing a space', () => {
    // A file URL percent-encodes the space; string interpolation does not.
    const pkg = resolve(dirname(DIST), '..')
    const copy = join(mkdtempSync(join(tmpdir(), 'veilio mcp ')), 'pkg')
    mkdirSync(copy)
    cpSync(join(pkg, 'dist'), join(copy, 'dist'), { recursive: true })
    cpSync(join(pkg, 'package.json'), join(copy, 'package.json'))
    // Resolve @veilio-inc/* from the workspace, as an install would.
    symlinkSync(resolve(pkg, '..', '..', 'node_modules'), join(copy, 'node_modules'))
    answersInitialize(join(copy, 'dist', 'index.js'))
  })

  it('stays silent when imported, so tests and embedders can load it', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(DIST)}); console.log('imported')`,
      ],
      { input: INITIALIZE, encoding: 'utf8', timeout: 15_000 }
    )
    expect(r.stdout.trim()).toBe('imported')
    expect(r.stderr).not.toContain('veilio-mcp: serving')
  })
})
