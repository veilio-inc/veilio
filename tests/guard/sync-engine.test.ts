import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A mod can only import files inside its plugin directory, so the engine's
// build is copied in. The copy must equal the build, or the guard runs an
// engine nobody tested.
const ROOT = join(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/sync-guard-engine.mjs')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'guard-sync-'))
  mkdirSync(join(tmp, 'packages/engine/dist'), { recursive: true })
  writeFileSync(join(tmp, 'packages/engine/dist/index.js'), "export * from './engine.js'\n")
  writeFileSync(
    join(tmp, 'packages/engine/dist/engine.js'),
    'export const a = 1\n//# sourceMappingURL=engine.js.map\n'
  )
  writeFileSync(join(tmp, 'packages/engine/dist/engine.js.map'), '{}')
  writeFileSync(join(tmp, 'packages/engine/dist/engine.d.ts'), 'export declare const a: 1\n')
  mkdirSync(join(tmp, 'plugins/veilio-guard'), { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function run(...args: string[]) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: err.stdout + err.stderr }
  }
}

describe('sync-guard-engine.mjs', () => {
  it('copies the JavaScript and the declarations, not the source maps', () => {
    expect(run().code).toBe(0)
    expect(readdirSync(join(tmp, 'plugins/veilio-guard/vendor/engine')).sort()).toEqual([
      'engine.d.ts',
      'engine.js',
      'index.js',
    ])
  })

  it('drops the comment that names a source map the plugin does not ship', () => {
    run()
    const copied = readFileSync(join(tmp, 'plugins/veilio-guard/vendor/engine/engine.js'), 'utf8')
    expect(copied).toBe('export const a = 1\n')
  })

  it('--check passes when the copy equals the build', () => {
    run()
    expect(run('--check').code).toBe(0)
  })

  it('--check fails and names the file when one byte differs', () => {
    run()
    writeFileSync(join(tmp, 'plugins/veilio-guard/vendor/engine/engine.js'), 'export const a = 2\n')
    const r = run('--check')
    expect(r.code).toBe(1)
    expect(r.out).toContain('engine.js')
  })

  it('--check fails on a file the build no longer has', () => {
    run()
    writeFileSync(join(tmp, 'plugins/veilio-guard/vendor/engine/stale.js'), '')
    const r = run('--check')
    expect(r.code).toBe(1)
    expect(r.out).toContain('stale.js')
  })

  it('--check fails when the build is missing, instead of passing on nothing', () => {
    run()
    rmSync(join(tmp, 'packages/engine/dist'), { recursive: true })
    expect(run('--check').code).not.toBe(0)
  })

  it('a sync removes a file the build no longer has', () => {
    run()
    writeFileSync(join(tmp, 'plugins/veilio-guard/vendor/engine/stale.js'), '')
    run()
    expect(readdirSync(join(tmp, 'plugins/veilio-guard/vendor/engine'))).not.toContain('stale.js')
  })
})
