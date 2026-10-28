import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'

// Engine spec 013 R19: the CLI passes each file's kind (fileKindOf), never its
// path, so the environment-style credential rules reach `veilio scrub` and
// `veilio scan` while the test-file relaxation stays off. Unquoted, the value
// used to be split into identifier pieces and stored in the map.

const FILES: Record<string, string> = {
  '.env': 'DB_PASSWORD=Tr0ub4dor zebra91\nAPP_ENV=production\n',
  'compose.yml': 'services:\n  db:\n    environment:\n      API_TOKEN: Tr0ub4dor zebra91\n',
  'deploy.sh': 'export STRIPE_SECRET_KEY=Tr0ub4dorZebra91\nnode server.js\n',
  'src/config.ts': 'export const DB_PASSWORD_NAME = "DB_PASSWORD"\n',
  // A test file stays strict: a weak fixed-name value is redacted there too.
  'tests/fixtures/.env': 'PGPASSWORD=postgres\n',
}

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-kind-'))
  mkdirSync(join(cwd, '.git'))
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(cwd, name, '..'), { recursive: true })
    writeFileSync(join(cwd, name), text)
  }
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

async function run(args: string[], stdin = '') {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(args, io)
  return { code, out, err }
}

describe('veilio scrub: the file kind reaches the engine', () => {
  for (const file of ['.env', 'compose.yml', 'deploy.sh']) {
    it(`${file}: the value is redacted and no piece of it is in the map`, async () => {
      const r = await run(['scrub', '--map', 'm.json', file])
      expect(r.code).toBe(EXIT_OK)
      expect(r.out).toMatch(/__REDACTED_[A-Z_]+_\d+__/)
      expect(r.out).not.toMatch(/Tr0ub4dor|zebra91|Zebra91/)
      const map = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).map as Record<
        string,
        string
      >
      expect(Object.values(map).join(' ')).not.toMatch(/Tr0ub4dor|zebra91|Zebra91/)
    })
  }

  it('a test file is not relaxed: a weak fixed-name value is still redacted', async () => {
    const r = await run(['scrub', '--map', 'm.json', 'tests/fixtures/.env'])
    expect(r.out).toMatch(/^PGPASSWORD=__REDACTED_[A-Z_]+_\d+__/)
  })

  it('stdin has no file kind: read as before', async () => {
    const r = await run(['scrub', '--map', 'm.json'], 'DB_PASSWORD=Tr0ub4dor zebra91\n')
    expect(r.out).not.toMatch(/__REDACTED_/)
  })
})

describe('veilio scan: the file kind reaches the engine', () => {
  it('reports the credential in a .env file', async () => {
    const r = await run(['scan', '--json', '.env'])
    const findings = JSON.parse(r.out) as unknown[]
    expect(findings.length).toBeGreaterThan(0)
  })
})
