import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Spec 078 review round 1 item 1: the CLI and the MCP server are published
 * with a range on @veilio-inc/engine, and npm installs the newest engine that
 * range allows. The workspace links the local engine, so every test here
 * passes against exports npm may not have yet (`shortNameAlias` was one). The
 * publish workflow runs scripts/check-engine-exports.mjs before anything is
 * published: it fails when an engine export the built tools import is missing
 * from the engine their range resolves to.
 *
 * Paths resolve from the vitest root.
 */

const SCRIPT = resolve('scripts/check-engine-exports.mjs')
const WORKFLOW = '.github/workflows/publish-tools.yml'

let base: string
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(base, rel)), { recursive: true })
  writeFileSync(join(base, rel), text)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'veilio-engine-exports-'))
  for (const pkg of ['cli', 'mcp'])
    put(
      `tools/packages/${pkg}/package.json`,
      JSON.stringify({
        name: `@veilio-inc/${pkg}`,
        dependencies: { '@veilio-inc/engine': '^1.0.0' },
      })
    )
  put(
    'tools/packages/cli/dist/a.js',
    "import { restore, isRawOnly as rawOnly } from '@veilio-inc/engine';\nimport { x } from './b.js';\n"
  )
  put(
    'tools/packages/mcp/dist/sub/b.js',
    'import {\n  scanSecrets,\n  shortNameAlias,\n} from \'@veilio-inc/engine\'\nexport { windowsAlias } from "@veilio-inc/engine";\n'
  )
  put(
    'engine/package.json',
    JSON.stringify({
      name: '@veilio-inc/engine',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    })
  )
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const run = () =>
  spawnSync(
    process.execPath,
    [SCRIPT, '--root', join(base, 'tools'), '--engine', join(base, 'engine')],
    {
      encoding: 'utf8',
    }
  )

describe('the engine exports the published tools import', () => {
  it('fails, naming each missing export and its package, when the engine lacks one', () => {
    put('engine/dist/index.js', 'export const restore = 1, isRawOnly = 1, scanSecrets = 1\n')
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('@veilio-inc/mcp imports shortNameAlias')
    // A re-export (`export { windowsAlias } from`) is an import too.
    expect(r.stderr).toContain('@veilio-inc/mcp imports windowsAlias')
    expect(r.stderr).not.toMatch(/imports (restore|isRawOnly|scanSecrets)\b/)
  })

  it('passes when every import is exported', () => {
    put(
      'engine/dist/index.js',
      'export const restore = 1, isRawOnly = 1, scanSecrets = 1, shortNameAlias = 1, windowsAlias = 1\n'
    )
    const r = run()
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('fails when a package has no build to read', () => {
    put('engine/dist/index.js', 'export const restore = 1\n')
    rmSync(join(base, 'tools/packages/cli/dist'), { recursive: true })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('@veilio-inc/cli')
  })

  it('runs in the publish workflow after the build and before anything is published', () => {
    const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l))
    const build = at(/name: Build, typecheck and test the packages/)
    const check = at(/run: node scripts\/check-engine-exports\.mjs\s*$/)
    const publish = at(/uses: changesets\/action@/)
    expect(build).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(build)
    expect(publish).toBeGreaterThan(check)
  })
})
