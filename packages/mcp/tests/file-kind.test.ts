// Engine spec 013 R19: the MCP server passes each file's kind (fileKindOf),
// never its path, so the environment-style credential rules reach
// anonymize_file and scan_secrets while the test-file relaxation stays off.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTool, type ToolContext } from '../src/tools.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

const FILES: Record<string, string> = {
  '.env': 'DB_PASSWORD=Tr0ub4dor zebra91\nAPP_ENV=production\n',
  'compose.yml': 'services:\n  db:\n    environment:\n      API_TOKEN: Tr0ub4dor zebra91\n',
  'deploy.sh': 'export STRIPE_SECRET_KEY=Tr0ub4dorZebra91\nnode server.js\n',
  'tests/fixtures/.env': 'PGPASSWORD=postgres\n',
}

let base: string
let ctx: ToolContext
let mapPath: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-mcp-kind-')))
  const root = join(base, 'proj')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  mapPath = join(base, 'map.json')
  ctx = { cwd: root, mapPath, home: join(base, 'home') }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('anonymize_file: the file kind reaches the engine', () => {
  for (const file of ['.env', 'compose.yml', 'deploy.sh']) {
    it(`${file}: the value is redacted and no piece of it is in the map`, () => {
      const out = callTool('anonymize_file', { path: file }, ctx).text
      expect(out).toMatch(/__REDACTED_[A-Z_]+_\d+__/)
      expect(out).not.toMatch(/Tr0ub4dor|zebra91|Zebra91/)
      expect(readFileSync(mapPath, 'utf8')).not.toMatch(/Tr0ub4dor|zebra91|Zebra91/)
    })
  }

  it('a test file is not relaxed: a weak fixed-name value is still redacted', () => {
    const out = callTool('anonymize_file', { path: 'tests/fixtures/.env' }, ctx).text
    expect(out).not.toContain('PGPASSWORD=postgres')
    expect(out).toContain('__REDACTED_')
  })

  it('inline text has no file kind: read as before', () => {
    const out = callTool('anonymize_text', { text: 'DB_PASSWORD=Tr0ub4dor zebra91\n' }, ctx).text
    expect(out).not.toContain('__REDACTED_')
  })
})

describe('scan_secrets: the file kind reaches the engine', () => {
  it('reports the credential in a .env file', () => {
    const out = callTool('scan_secrets', { path: '.env' }, ctx).text
    expect(out).not.toMatch(/no credentials|nothing found/i)
    expect(out).toMatch(/credential/i)
  })
})
