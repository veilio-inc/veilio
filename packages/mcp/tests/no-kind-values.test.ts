// Security review, round 4 (A): text of no file kind - anonymize_text, a .md,
// a .txt - is read by every value grammar, so a credential's value is
// redacted one-way and any other value is masked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTool, type ToolContext } from '../src/tools.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

let base: string
let ctx: ToolContext
let mapPath: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-mcp-nokind-')))
  const root = join(base, 'proj')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'NOTES.md'), '# Setup\n\nDB_PASSWORD=Summer2024!\n')
  writeFileSync(join(root, 'prod.tfvars'), 'db_password = Summer2024!\n')
  mapPath = join(base, 'map.json')
  ctx = { cwd: root, mapPath, home: join(base, 'home') }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const map = () => {
  try {
    return readFileSync(mapPath, 'utf8')
  } catch {
    return ''
  }
}

describe('anonymize_text: every value grammar applies', () => {
  it('DB_PASSWORD=Summer2024! is redacted whole, one-way, and restore never returns it', () => {
    const out = callTool('anonymize_text', { text: 'DB_PASSWORD=Summer2024!' }, ctx).text
    expect(out).not.toContain('Summer2024')
    expect(out).toMatch(/DB_PASSWORD=__REDACTED_CREDENTIAL_\d+__/)
    expect(map()).not.toContain('Summer2024')
    const masked = /DB_PASSWORD=__REDACTED_CREDENTIAL_\d+__/.exec(out)![0]
    expect(callTool('restore_text', { text: masked }, ctx).text).not.toContain('Summer2024')
  })

  it('export API_TOKEN=sunshine is redacted', () => {
    const out = callTool('anonymize_text', { text: 'export API_TOKEN=sunshine\n' }, ctx).text
    expect(out).not.toContain('sunshine')
    expect(out).toContain('__REDACTED_CREDENTIAL_')
    expect(map()).not.toContain('sunshine')
  })

  it.each([
    ['GREETING=sunshine\n', 'sunshine'],
    ['codename: falcon\n', 'falcon'],
  ])('%j masks %s reversibly', (text, word) => {
    const out = callTool('anonymize_text', { text }, ctx).text
    expect(out).not.toMatch(new RegExp(`\\b${word}\\b`))
    expect(out).not.toContain('__REDACTED_')
    expect(map()).toContain(word)
  })
})

describe('anonymize_file: a file of no kind is read the same way', () => {
  it.each(['NOTES.md', 'prod.tfvars'])('%s', (path) => {
    const out = callTool('anonymize_file', { path }, ctx).text
    expect(out).not.toContain('Summer2024')
    expect(out).toContain('__REDACTED_CREDENTIAL_')
    expect(map()).not.toContain('Summer2024')
  })
})

describe('scan_secrets: a credential value in text of no kind is reported', () => {
  it('password: Summer2024!', () => {
    const out = callTool('scan_secrets', { text: 'password: Summer2024!\n' }, ctx).text
    expect(out).not.toMatch(/No credentials detected/)
    expect(out).not.toContain('Summer2024')
  })

  it('a .md file', () => {
    const out = callTool('scan_secrets', { path: 'NOTES.md' }, ctx).text
    expect(out).not.toMatch(/No credentials detected/)
  })
})
