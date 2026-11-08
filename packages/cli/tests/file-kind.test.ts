import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, type Io } from '../src/commands.js'

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

  // Round 4 (A): text of no kind is read by every value grammar.
  it('stdin has no file kind: every value grammar applies', async () => {
    const r = await run(['scrub', '--map', 'm.json'], 'DB_PASSWORD=Tr0ub4dor zebra91\n')
    expect(r.out).toMatch(/__REDACTED_/)
    expect(r.out).not.toMatch(/Tr0ub4dor|zebra91/)
  })
})

describe('veilio scan: the file kind reaches the engine', () => {
  it('reports the credential in a .env file', async () => {
    const r = await run(['scan', '--json', '.env'])
    const findings = JSON.parse(r.out) as unknown[]
    expect(findings.length).toBeGreaterThan(0)
  })
})

// Spec 085 L1 (security audit run-1): the pre-commit hook piped the whole
// staged diff into `veilio scan`, which then had no file name, so the .env,
// YAML and shell rules were off. `--name` gives stdin the name it has.
describe('veilio scan --name: stdin scanned as the file it names (L1)', () => {
  const ENV = 'DB_PASSWORD=NotARealPass9\n'
  it('the audit case 1: `scan .env` blocks', async () => {
    writeFileSync(join(cwd, '.env'), ENV)
    expect((await run(['scan', '--quiet', '.env'])).code).toBe(EXIT_FINDINGS)
  })

  it('the same text on stdin with --name .env blocks, and names the file', async () => {
    const r = await run(['scan', '--name', '.env'], ENV)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain('.env')
    expect(r.err).not.toContain('<stdin>')
  })

  it('--name config/prod.env reads it as a .env file too', async () => {
    expect((await run(['scan', '--quiet', '--name', 'config/prod.env'], ENV)).code).toBe(
      EXIT_FINDINGS
    )
  })

  it('--name src/gateway.ts with code holding no credential passes', async () => {
    const r = await run(
      ['scan', '--quiet', '--name', 'src/gateway.ts'],
      'export const PaymentGateway = (x: number) => x\n'
    )
    expect(r.code).toBe(EXIT_OK)
  })

  it('--name with file names is a usage error', async () => {
    writeFileSync(join(cwd, '.env'), ENV)
    const r = await run(['scan', '--name', '.env', '.env'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(
      'veilio: --name names what comes on stdin, so it cannot be used with file names.'
    )
  })

  it('--name belongs to scan only', async () => {
    expect((await run(['scrub', '--name', '.env'], ENV)).code).toBe(EXIT_ERROR)
  })
})
