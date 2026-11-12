import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * The Action runs `npx @veilio-inc/cli@<version>` in the adopter's CI, with
 * their repository's token and, on pull_request_target, their secrets. A
 * default of `latest` hands that seat to whatever is published next. The
 * default is the exact CLI version this repository releases with the Action,
 * and `npm run version-packages` moves it in the same commit as the version.
 */
const ACTION = 'packages/cli/action.yml'
const MANIFEST = 'packages/cli/package.json'
const defaultVersion = (file = ACTION) =>
  (parse(readFileSync(file, 'utf8')) as { inputs: { version: { default: string } } }).inputs.version
    .default

describe("the Action's default CLI version", () => {
  it('is the exact version packages/cli releases with', () => {
    const { version } = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string }
    expect(defaultVersion()).toBe(version)
    expect(defaultVersion()).not.toBe('latest')
  })

  it('is moved by the release script, not by hand', () => {
    const root = mkdtempSync(join(tmpdir(), 'veilio-action-pin-'))
    mkdirSync(join(root, 'packages/cli'), { recursive: true })
    cpSync(ACTION, join(root, ACTION))
    writeFileSync(join(root, MANIFEST), JSON.stringify({ version: '9.8.7' }))
    execFileSync(process.execPath, ['scripts/sync-action-version.mjs', '--root', root])
    expect(defaultVersion(join(root, ACTION))).toBe('9.8.7')
    // Only the version input changed.
    const before = readFileSync(ACTION, 'utf8').split('\n')
    const after = readFileSync(join(root, ACTION), 'utf8').split('\n')
    expect(after.length).toBe(before.length)
    expect(after.filter((l, i) => l !== before[i])).toHaveLength(1)
  })

  it('runs as part of `npm run version-packages`', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['version-packages']).toMatch(/changeset version.*sync-action-version\.mjs/)
  })
})
