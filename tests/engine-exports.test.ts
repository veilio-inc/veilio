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

  // Review round 3 #4: `exports` written as conditions alone is the `.` entry.
  it('reads an exports field of conditions alone as the package entry', () => {
    put(
      'engine/package.json',
      JSON.stringify({
        name: '@veilio-inc/engine',
        type: 'module',
        exports: { import: './dist/index.js', default: './dist/index.js' },
      })
    )
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

  // Review round 2 #8: every import form, and mcp's imports from the CLI
  // against the CLI's own range.
  describe('every import form', () => {
    const ENGINE_ALL =
      'export const restore = 1, isRawOnly = 1, scanSecrets = 1, shortNameAlias = 1, windowsAlias = 1\n'
    beforeEach(() => {
      put('engine/dist/index.js', ENGINE_ALL)
      put(
        'tools/packages/mcp/package.json',
        JSON.stringify({
          name: '@veilio-inc/mcp',
          dependencies: { '@veilio-inc/engine': '^1.0.0', '@veilio-inc/cli': '^0.9.0' },
        })
      )
      put(
        'cli/package.json',
        JSON.stringify({
          name: '@veilio-inc/cli',
          version: '0.9.0',
          type: 'module',
          exports: { '.': './dist/index.js', './store': './dist/store.js' },
        })
      )
      put('cli/dist/index.js', 'export const main = 1\n')
      put('cli/dist/store.js', 'export const loadMap = 1, saveMap = 1\n')
    })
    const runAll = () =>
      spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--root',
          join(base, 'tools'),
          '--engine',
          join(base, 'engine'),
          '--cli',
          join(base, 'cli'),
        ],
        { encoding: 'utf8' }
      )

    it('passes when every form finds what it imports', () => {
      put(
        'tools/packages/cli/dist/c.js',
        "import * as engine from '@veilio-inc/engine'\nengine.restore(engine.isRawOnly)\n"
      )
      put(
        'tools/packages/mcp/dist/d.js',
        "import { loadMap } from '@veilio-inc/cli/store'\nconst m = await import('@veilio-inc/engine')\nm.scanSecrets()\n"
      )
      const r = runAll()
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    })

    for (const [form, file, text, says] of [
      [
        'a namespace member',
        'cli/dist/c.js',
        "import * as engine from '@veilio-inc/engine'\nengine.parseThings()\n",
        '@veilio-inc/cli imports parseThings',
      ],
      [
        'a default import',
        'cli/dist/c.js',
        "import engine from '@veilio-inc/engine'\n",
        '@veilio-inc/cli imports default',
      ],
      [
        'a dynamic import, destructured',
        'mcp/dist/d.js',
        "const { parseThings } = await import('@veilio-inc/engine')\n",
        '@veilio-inc/mcp imports parseThings',
      ],
      [
        'a dynamic import, as a namespace',
        'mcp/dist/d.js',
        'const e = await import("@veilio-inc/engine")\ne.parseThings()\n',
        '@veilio-inc/mcp imports parseThings',
      ],
      [
        'a subpath the engine does not export',
        'cli/dist/c.js',
        "import { x } from '@veilio-inc/engine/internal'\n",
        '@veilio-inc/cli imports @veilio-inc/engine/internal',
      ],
      [
        'a CLI subpath the CLI does not export',
        'mcp/dist/d.js',
        "import { y } from '@veilio-inc/cli/missing'\n",
        '@veilio-inc/mcp imports @veilio-inc/cli/missing',
      ],
      [
        'a CLI export the CLI lacks',
        'mcp/dist/d.js',
        "import { loadMap, dropMap } from '@veilio-inc/cli/store'\n",
        '@veilio-inc/mcp imports dropMap',
      ],
    ] as const)
      it(`fails on ${form}`, () => {
        put(`tools/packages/${file}`, text)
        const r = runAll()
        expect(r.status).toBe(1)
        expect(r.stderr).toContain(says)
      })
  })

  // The CLI and the MCP server are released together by changesets: the MCP
  // server's CLI range names a CLI version that is not on npm until the same
  // run publishes it, so the workspace CLI is the one checked.
  it('checks a sibling tool released in the same run against the workspace copy, not npm', () => {
    put(
      'engine/dist/index.js',
      'export const restore = 1, isRawOnly = 1, scanSecrets = 1, shortNameAlias = 1, windowsAlias = 1\n'
    )
    put(
      'tools/packages/cli/package.json',
      JSON.stringify({
        name: '@veilio-inc/cli',
        version: '97.3.0',
        type: 'module',
        exports: { './store': './dist/store.js' },
        dependencies: { '@veilio-inc/engine': '^1.0.0' },
      })
    )
    put('tools/packages/cli/dist/store.js', 'export const openStore = 1\n')
    put(
      'tools/packages/mcp/package.json',
      JSON.stringify({
        name: '@veilio-inc/mcp',
        dependencies: { '@veilio-inc/engine': '^1.0.0', '@veilio-inc/cli': '^97.3.0' },
      })
    )
    put('tools/packages/mcp/dist/c.js', "import { openStore } from '@veilio-inc/cli/store'\n")
    const r = run()
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('@veilio-inc/cli@97.3.0 (^97.3.0)')
  })

  // Outside the caret range the workspace copy is not used (npm is asked, and
  // has no such version here): a higher major, a lower patch, and for 0.x a
  // higher minor.
  for (const [local, range] of [
    ['98.0.0', '^97.3.0'],
    ['97.2.9', '^97.3.0'],
    ['0.11.0', '^0.10.0'],
  ])
    it(`does not use a workspace sibling at ${local} for ${range}`, () => {
      put(
        'engine/dist/index.js',
        'export const restore = 1, isRawOnly = 1, scanSecrets = 1, shortNameAlias = 1, windowsAlias = 1\n'
      )
      put(
        'tools/packages/cli/package.json',
        JSON.stringify({
          name: '@veilio-inc/cli',
          version: local,
          type: 'module',
          exports: { './store': './dist/store.js' },
          dependencies: { '@veilio-inc/engine': '^1.0.0' },
        })
      )
      put('tools/packages/cli/dist/store.js', 'export const openStore = 1\n')
      put(
        'tools/packages/mcp/package.json',
        JSON.stringify({
          name: '@veilio-inc/mcp',
          dependencies: { '@veilio-inc/engine': '^1.0.0', '@veilio-inc/cli': range },
        })
      )
      put('tools/packages/mcp/dist/c.js', "import { openStore } from '@veilio-inc/cli/store'\n")
      const r = run()
      expect(r.status).not.toBe(0)
      expect(r.stdout).not.toContain(`@veilio-inc/cli@${local}`)
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
