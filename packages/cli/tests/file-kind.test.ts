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
    stdinBytes: async function* () {
      yield Buffer.from(stdin)
    },
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

// A Kubernetes Secret is read in a YAML or JSON file, and never in code.
describe('veilio scrub: a Secret manifest is a YAML or JSON document', () => {
  const VALUE = 'bGVkZ2VyIHN0YWdpbmcgZGF0YWJhc2UgcGFzc3dvcmQ'
  const mapOf = (): string =>
    Object.values(
      JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).map as Record<string, string>
    ).join(' ')

  it.each([
    ['secret.yaml', `apiVersion: v1\nkind: Secret\ndata:\n  db: ${VALUE}\n`],
    ['secret.json', `{\n  "kind": "Secret",\n  "data": {\n    "db": "${VALUE}"\n  }\n}\n`],
  ])('%s: the value is redacted and not in the map', async (file, text) => {
    writeFileSync(join(cwd, file), text)
    const r = await run(['scrub', '--map', 'm.json', file])
    expect(r.out).toMatch(/__REDACTED_CREDENTIAL_1__/)
    expect(r.out + mapOf()).not.toContain(VALUE.slice(0, 12))
  })

  it('src/kinds.ts: an object named data keeps its names, in the map', async () => {
    const code =
      "const item = { kind: 'Secret' }\nfunction loadUsers(username: string, pageSize: number) {\n  return post(url, {\n    data: { username, pageSize, retries: maxRetries },\n  })\n}\n"
    writeFileSync(join(cwd, 'src/kinds.ts'), code)
    const r = await run(['scrub', '--map', 'm.json', 'src/kinds.ts'])
    expect(r.out).not.toContain('__REDACTED_')
    expect(r.out).not.toMatch(/username|pageSize|maxRetries/)
    for (const name of ['username', 'pageSize', 'maxRetries']) expect(mapOf()).toContain(name)
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

// Spec 094: a glob (`build/*`, `src/**`) in a script, a Dockerfile, a workflow
// or a Makefile opens no comment, so the names after it are masked.
describe('veilio scrub: a glob in a file that is not source code opens no comment', () => {
  const GLOBS: Record<string, string> = {
    'd.sh': 'set -e\nrm -rf build/*\ncustomerTotal=1\nsettleInvoice "$acme_corp" //AcmePay\n',
    Dockerfile: 'COPY packages/*/package.json ./\nRUN ./acme_refunds --AcmePay settleInvoice\n',
    'ci.yml': 'paths:\n  - src/**\njobs:\n  acme_refunds:\n    name: AcmePay settleInvoice\n',
    Makefile: 'SOURCES := src/*.c\n\nacme_refunds: $(SOURCES)\n\t./settleInvoice --AcmePay\n',
  }
  const NAMES = /customerTotal|settleInvoice|acme_corp|acme_refunds|AcmePay/
  const WARNING = (file: string, language: string) =>
    `veilio: ${file}: no language marker matched — masked as ${language}, which may be wrong. Pass --language to be sure.\n`
  beforeEach(() => {
    for (const [name, text] of Object.entries(GLOBS)) writeFileSync(join(cwd, name), text)
  })

  it('every name after the glob is masked and in the map', async () => {
    const r = await run(['scrub', '--map', 'm.json', ...Object.keys(GLOBS)])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).not.toMatch(NAMES)
    const map = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).map as Record<string, string>
    // A shell variable is held with its `$`.
    const held = Object.values(map).map((value) => value.replace(/^\$/, ''))
    for (const planted of Object.values(GLOBS).join('').match(new RegExp(NAMES, 'g'))!)
      expect(held).toContain(planted)
  })

  it.each(Object.keys(GLOBS))('%s comes back exactly', async (file) => {
    const masked = await run(['scrub', '--map', 'm.json', file])
    expect(masked.out).not.toMatch(NAMES)
    const back = await run(['restore', '--map', 'm.json'], masked.out)
    expect(back.out).toBe(GLOBS[file])
  })

  it('a named language does not bring the comment back', async () => {
    const r = await run(['scrub', '--map', 'm.json', '--language', 'typescript', 'd.sh'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).not.toMatch(NAMES)
  })

  it('the warning about a language no marker matched is as it was', async () => {
    const r = await run(['scrub', '--map', 'm.json', '--quiet', ...Object.keys(GLOBS)])
    expect(r.err).toBe(
      ['d.sh', 'Dockerfile', 'ci.yml']
        .map((file) => WARNING(file, 'TypeScript / JavaScript'))
        .join('')
    )
  })
})
