import { describe, expect, it } from 'vitest'
import { anonymize, credentialSpans, detectSecrets, fileKindOf, scanSecrets } from '../src/index.js'

// Engine 1.12.2 (spec 013 research R17): a credential assigned to an
// environment-style name - DB_PASSWORD=..., export ..., YAML - was split into
// identifier pieces and stored in the symbol map. The rules apply in dotenv,
// YAML and shell files only; anywhere else the engine behaves as 1.12.1 (R18).
// Every case checks the output AND the map: a credential never goes into it.

const mapped = (r: { map: Record<string, string> }) => Object.values(r.map)
const REDACTED = /__REDACTED_[A-Z_]+_\d+__/
const leaked = (r: { anonymized: string; map: Record<string, string> }, re: RegExp) =>
  re.test([r.anonymized, ...mapped(r)].join('\n'))

const FORMS: [string, (n: string, v: string) => string, string][] = [
  ['dotenv', (n, v) => `${n}=${v}\nAPP_ENV=production\n`, '.env'],
  ['dotenv with export', (n, v) => `export ${n}=${v}\n`, 'config/production.env'],
  ['shell export', (n, v) => `export ${n}=${v}\nnode server.js\n`, 'deploy.sh'],
  ['Dockerfile ENV', (n, v) => `FROM node:20\nENV ${n}=${v}\n`, 'Dockerfile'],
  ['YAML map', (n, v) => `services:\n  db:\n    environment:\n      ${n}: ${v}\n`, 'compose.yml'],
  ['compose list', (n, v) => `environment:\n  - ${n}=${v}\n`, 'compose.yaml'],
]
const NAMES = [
  'DB_PASSWORD',
  'STRIPE_SECRET_KEY',
  'GITHUB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'PASSWORD',
  'APP_PASSPHRASE',
  'SMTP_PASS',
  'OPENAI_API_KEY',
]
const VALUES = ['Tr0ub4dor-zebra-91', 'pa#ssWord-Quokka7', 'Xk9!mQ2vL7pZ']
const pieces = (v: string) =>
  new RegExp(
    v
      .split(/[^A-Za-z0-9]+/)
      .filter((p) => p.length >= 4)
      .join('|')
  )

describe('engine 1.12.2: environment-style credentials in dotenv, YAML and shell files', () => {
  for (const [form, make, path] of FORMS) {
    for (const name of NAMES) {
      for (const value of VALUES) {
        it(`${form}: ${name}=${value} is redacted and kept out of the map`, () => {
          const r = anonymize(make(name, value), { path })
          expect(leaked(r, pieces(value)), r.anonymized).toBe(false)
          expect(r.anonymized).toMatch(REDACTED)
          expect(r.anonymized).toContain(name)
        })
      }
    }
  }

  it('scanSecrets and detectSecrets report it too', () => {
    const s = scanSecrets('DB_PASSWORD=Tr0ub4dor-zebra-91\n', 'redact', { path: '.env' })
    expect(s.code).not.toContain('Tr0ub4dor')
    const f = detectSecrets('DB_PASSWORD=Tr0ub4dor-zebra-91\n', { path: '.env' })
    expect(f.some((x) => x.line === 1 && x.length === 'Tr0ub4dor-zebra-91'.length)).toBe(true)
  })
})

describe('engine 1.12.2: the whole value, as the file reads it', () => {
  const whole = [
    ['a value starting with $', 'DB_PASSWORD=$ecr3tPass-91\n', '.env'],
    ['a value starting with $, YAML', 'DB_PASSWORD: $ecr3tPass-91\n', 'compose.yml'],
    ['a ; inside a dotenv value', 'DB_PASSWORD=Tr0ub4dor;zebra91\n', '.env'],
    ['an & inside a dotenv value', 'DB_PASSWORD=Tr0ub4dor&zebra91\n', '.env'],
    ['a | inside a dotenv value', 'DB_PASSWORD=Tr0ub4dor|zebra91\n', '.env'],
    ['a quote inside a dotenv value', 'DB_PASSWORD=Tr0ub4dor"zebra91\n', '.env'],
    ['a space inside a dotenv value', 'DB_PASSWORD=Tr0ub4dor zebra91\n', '.env'],
    ['spaces around = in dotenv', 'DB_PASSWORD = Tr0ub4dor zebra91\n', '.env'],
    ['a space inside a YAML value', 'DB_PASSWORD: Tr0ub4dor zebra91 # rotated\n', 'compose.yml'],
    ['a YAML value ending in a comma', 'API_TOKEN: Tr0ub4dor zebra91,\n', 'compose.yml'],
    ['a fixed name with ; inside, dotenv', 'PGPASSWORD=Tr0ub4dor;zebra91\n', '.env'],
    ['a fixed name with a space, YAML', 'POSTGRES_PASSWORD: Tr0ub4dor zebra91\n', 'compose.yml'],
    ['a CRLF dotenv file', 'DB_PASSWORD=Tr0ub4dor zebra91\r\nAPP=1\r\n', '.env'],
    ['a ) inside a shell value', 'export DB_PASSWORD=abc)Tr0ub4dorZebra91\n', 'a.sh'],
    ['a lower-case name in dotenv', 'db_password=Tr0ub4dor zebra91\n', '.env'],
    ['a mixed-case name in dotenv', 'Db_Password=Tr0ub4dor zebra91\n', '.env'],
    ['a quoted compose item', 'environment:\n  - "DB_PASSWORD=Tr0ub4dor zebra91"\n', 'compose.yml'],
    [
      'a YAML line indented 42 spaces',
      ' '.repeat(42) + 'DB_PASSWORD: Tr0ub4dor zebra91\n',
      'values.yaml',
    ],
    ['a name longer than 64 characters', 'A'.repeat(70) + '_PASSWORD=Tr0ub4dor zebra91\n', '.env'],
  ] as const
  for (const [what, text, path] of whole) {
    it(`${what}: nothing of it reaches output or map`, () => {
      const r = anonymize(text, { path })
      expect(leaked(r, /Tr0ub4dor|zebra91|ecr3tPass/), r.anonymized).toBe(false)
    })
  }

  it('a comment after a dotenv or YAML value stays; a glued # is part of the value', () => {
    expect(
      anonymize('DB_PASSWORD=Tr0ub4dor zebra91 # rotated\n', { path: '.env' }).anonymized
    ).toMatch(/^DB_PASSWORD=__REDACTED_[A-Z_]+_\d+__ # \S+\n$/)
    expect(anonymize('DB_PASSWORD: Tr0ub4dor zebra91 # c\n', { path: 'c.yml' }).anonymized).toMatch(
      /^DB_PASSWORD: __REDACTED_[A-Z_]+_\d+__ # c\n$/
    )
    const r = anonymize('DB_PASSWORD=Tr0ub4dor#zebra91\n', { path: '.env' })
    expect(leaked(r, /Tr0ub4dor|zebra91/)).toBe(false)
  })

  it('a quoted compose item keeps its closing quote', () => {
    const r = anonymize('environment:\n  - "DB_PASSWORD=Tr0ub4dor-zebra-91"\n', {
      path: 'compose.yml',
    })
    expect(r.anonymized).toMatch(/- "DB_PASSWORD=__REDACTED_[A-Z_]+_\d+__"\n$/)
  })

  it('in a shell line whitespace and ; end the value, so the command stays', () => {
    expect(anonymize('PGPASSWORD=Tr0ub4dor psql -h db\n', { path: 'run.sh' }).anonymized).toMatch(
      /^PGPASSWORD=__REDACTED_[A-Z_]+_\d+__ \S+ -h \S+\n$/
    )
    expect(
      anonymize('export DB_PASSWORD=Tr0ub4dor-zebra-91; node app.js\n', { path: 'a.sh' }).anonymized
    ).toMatch(/DB_PASSWORD=__REDACTED_[A-Z_]+_\d+__; /)
  })

  it('a long value is redacted whole', () => {
    // No repetition, so the spread of a capped head cannot hide a plain tail.
    const long = Array.from({ length: 700 }, (_, i) => `q${i}z`).join('-')
    for (const [text, path] of [
      [`DB_PASSWORD=${long.replace(/-/g, ' ')}\n`, '.env'],
      [`export DB_PASSWORD=${long}\n`, 'a.sh'],
      // (PGPASSWORD's own rule keeps 1.12.1's 256-character grammar: review of f26b887.)
    ] as const) {
      expect(leaked(anonymize(text, { path }), /q699z|q350z/), text.slice(0, 30)).toBe(false)
    }
  })
})

describe('engine 1.12.2: what stays readable', () => {
  const notRedacted = [
    ['a ${} reference', 'DB_PASSWORD=${DB_PASSWORD}\n', '.env'],
    ['a $ reference', 'export DB_PASSWORD=$DB_PASSWORD\n', 'a.sh'],
    ['a ${} reference in YAML', 'DB_PASSWORD: ${DB_PASSWORD}\n', 'compose.yml'],
    ['an empty value', 'DB_PASSWORD=\n', '.env'],
    ['a GitHub Actions expression', 'DB_PASSWORD: ${{ secrets.DB_PASSWORD }}\n', 'ci.yml'],
    ['a <placeholder>', 'DB_PASSWORD=<your password>\n', '.env'],
    ['a path held by a _FILE name', 'DB_PASSWORD_FILE=/run/secrets/db\n', '.env'],
    ['a URL held by a TOKEN_URL name', 'TOKEN_URL=https://auth.example.com/oauth/token\n', '.env'],
    ['BYPASS_CACHE and PASSTHROUGH', 'BYPASS_CACHE=1\nPASSTHROUGH=true\n', '.env'],
    ['PWD, a path', 'PWD=/Users/dlugosh/Documents/Repository\n', '.env'],
    [
      'GOOGLE_APPLICATION_CREDENTIALS, a path',
      'GOOGLE_APPLICATION_CREDENTIALS=/etc/gcp/sa.json\n',
      '.env',
    ],
    ['booleans and numbers', 'REQUIRE_PASSWORD=true\nDEBUG=true\nENABLE_TOKEN=1\nPORT=1\n', '.env'],
    ['a number used elsewhere', 'MAX_TOKEN=4096\nlimit = 4096\n', '.env'],
    ['a YAML word used elsewhere', 'TOKEN: bearer\ntype: bearer\n', 'c.yml'],
    ['PRIMARY_KEY and SORT_KEY', 'PRIMARY_KEY=id\nSORT_KEY=createdAt\n', '.env'],
  ] as const
  for (const [what, text, path] of notRedacted) {
    it(`${what} is not redacted`, () => {
      expect(anonymize(text, { path }).anonymized).not.toMatch(REDACTED)
    })
  }

  // The syntax stays; words in it are masked as ordinary names, as on 1.12.1.
  it('YAML syntax is never a value: block indicators, a tag, an anchor', () => {
    for (const [text, kept] of [
      ['env:\n  DB_PASSWORD: >-\n    x\n', /DB_PASSWORD: >-\n/],
      ['env:\n  POSTGRES_PASSWORD: |\n    x\n', /POSTGRES_PASSWORD: \|\n/],
      ['DB_PASSWORD: !vault |\n  x\n', /^DB_PASSWORD: !\S+ \|\n/],
      ['DB_PASSWORD: &pw x\nOTHER: *pw\n', /^DB_PASSWORD: &\S+ /],
      ['DB_PASSWORD: |2\n  x\n', /^DB_PASSWORD: \|2\n/],
    ] as const) {
      const out = anonymize(text, { path: 'c.yml' }).anonymized
      expect(out, text).toMatch(kept)
      expect(out.split('\n')[text.startsWith('env') ? 1 : 0], text).not.toMatch(REDACTED)
    }
  })

  it('a map key in the slot: destroyed under a fixed name, kept under a convention name', () => {
    const map = { __VAR__1: 'x' }
    expect(
      anonymize('PGPASSWORD=__VAR__1\n', { path: '.env', existingMap: map }).anonymized
    ).toMatch(REDACTED)
    expect(anonymize('DB_PASSWORD=__VAR__1\n', { path: '.env', existingMap: map }).anonymized).toBe(
      'DB_PASSWORD=__VAR__1\n'
    )
  })

  it('a fixed name destroys a value; a convention name judges it as the quoted form does', () => {
    // A plain dictionary word is masked, not destroyed, under every rule - an
    // engine-wide policy since 1.12.1 (PGPASSWORD=changeme included).
    for (const v of ['changeme1', 'Tr0ub4dor-zebra-91'])
      expect(anonymize(`PGPASSWORD=${v}\n`, { path: '.env' }).anonymized, v).toMatch(REDACTED)
    for (const v of ['changeme', 'changeme1', 'secret', 'true', '4096', 'Tr0ub4dor-zebra-91']) {
      const bare = REDACTED.test(anonymize(`DB_PASSWORD=${v}\n`, { path: '.env' }).anonymized)
      const quoted = REDACTED.test(anonymize(`DB_PASSWORD="${v}"\n`, { path: '.env' }).anonymized)
      expect(bare, `${v}: bare ${bare}, quoted ${quoted}`).toBe(quoted)
    }
  })
})

// Research R18: outside dotenv, YAML and shell files the engine behaves as
// 1.12.1 did. Each case was clean on 1.12.1 and must stay clean.
describe('engine 1.12.2: nothing new outside dotenv, YAML and shell files', () => {
  const clean = [
    [
      'a TypeScript interface',
      'interface Env {\n  DB_PASSWORD: string\n}\nconst s: string = x\n',
      'a.ts',
    ],
    ['a TypeScript interface, no path', 'interface Env {\n  API_KEY: string;\n}\n', undefined],
    [
      'a pydantic model, no path',
      'class Settings(BaseSettings):\n    DB_PASSWORD: str\nx = str(1)\n',
      undefined,
    ],
    ['Optional[str], no path', 'class S:\n    DB_PASSWORD: Optional[str] = None\n', undefined],
    ['a typed field, no path', 'interface Env {\n  API_TOKEN: TokenV2Schema\n}\n', undefined],
    [
      'a multi-line object literal',
      'const config = {\n  DB_PASSWORD: dbPassword,\n  API_KEY: apiKey,\n}\n',
      'a.ts',
    ],
    [
      'a call as a property, no path',
      'const c = {\n  DB_PASSWORD: getSecret("db"),\n}\n',
      undefined,
    ],
    ['a ?? default in Markdown', '  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? ""\n', 'README.md'],
    [
      'prose in Markdown',
      'API_KEY: Required. Your key from the dashboard.\nTOKEN: see the vault\n',
      'README.md',
    ],
    ['a Python call', 'SECRET_KEY=os.getenv("SECRET_KEY")\nAPI_KEY=get_key()\n', 'a.py'],
    ['a JS call', 'TOKEN=getToken();\n', 'a.js'],
    ['a string in code', 'run("PGPASSWORD=$PGPASS")\n', 'a.py'],
    ['an env line in JSON', '{"env": "PGPASSWORD=$PGPASS", "x": 1}\n', 'a.json'],
  ] as const
  for (const [what, text, path] of clean) {
    it(`${what}: nothing is redacted`, () => {
      expect(anonymize(text, path === undefined ? {} : { path }).anonymized).not.toMatch(REDACTED)
    })
  }

  it('a quoted string keeps its closing quote (the 1.12.1 grammar for fixed names)', () => {
    expect(anonymize('run("PGPASSWORD=secret123")\n', { path: 'a.py' }).anonymized).toMatch(
      /"\)\n$/
    )
  })
})

describe('engine 1.12.2: placeholder-shaped credential values stay redacted (pinned from 1.12.1)', () => {
  const cases = [
    ['password = "__ZQ8VLM2XTQ__"', 'a.ts'],
    ['PGPASSWORD=__ZQ8VLM2XTQ__ psql', 'run.sh'],
    ['const apiKey = "__ZQ8VLM2XTQ__7"', 'a.ts'],
    ['curl --password __ZQ8VLM2XTQ__ https://x', 'run.sh'],
    ['POSTGRES_PASSWORD: __ZQ8VLM2XTQ__', 'compose.yml'],
    ['DB_PASSWORD=__ZQ8VLM2XTQ__', '.env'],
  ] as const
  for (const [text, path] of cases) {
    it(`${text} is redacted`, () => {
      expect(leaked(anonymize(text, { path }), /ZQ8VLM2XTQ/)).toBe(false)
    })
  }

  it('a real placeholder shape passes through, so anonymized text can be anonymized again', () => {
    expect(anonymize('password = "__CLS__1"', { path: 'a.ts' }).anonymized).toContain('"__CLS__1"')
  })
})

describe('engine 1.12.2: linear time on adversarial lines', () => {
  const timed = (text: string, path: string | undefined) => {
    const t0 = performance.now()
    anonymize(text, path === undefined ? {} : { path })
    return performance.now() - t0
  }
  it('runs of separators and spaces, digits after a name', () => {
    const cases: [string, string | undefined][] = [
      [`API_TOKEN: ${'1'.repeat(40)}x\n`, 'a.yml'],
      [`API_TOKEN: Abc${'1'.repeat(40)}x\n`, undefined],
      [`export A_TOKEN=${';'.repeat(4000)}a\n`.repeat(50), 'a.sh'],
      [`A_TOKEN: a${' '.repeat(4000)}b\n`.repeat(50), 'a.yml'],
      [`A_TOKEN=a${' '.repeat(4000)}b\n`.repeat(50), '.env'],
      [`A_TOKEN=a${' '.repeat(4000)}#\n`.repeat(50), '.env'],
      [`export A_TOKEN=${'${'.repeat(2000)}\n`.repeat(10), 'a.sh'],
      ['A_TOKEN="x\n'.repeat(2000), '.env'],
      ['export A_TOKEN="x\n'.repeat(3000), '.env'],
      ["export A_TOKEN='x\n".repeat(3000), '.env'],
      ["A_TOKEN: 'x\n".repeat(2000), 'a.yml'],
    ]
    for (const [text, path] of cases) expect(timed(text, path), text.slice(0, 30)).toBeLessThan(500)
  })
})

// Seeded, so a failure names a case that reproduces.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('engine 1.12.2: property - no generated credential reaches output or map', () => {
  it('holds across names, forms, values and entry points', () => {
    const next = rng(20261027)
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]
    const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    const SEP = ['-', '_', '.', '#', '!', '@', '%', '+']
    const PREFIX = ['DB', 'APP', 'REDIS', 'SMTP', 'STRIPE', 'MY_SERVICE', 'X1']
    const SUFFIX = [
      'PASSWORD',
      'PASSWD',
      'PWD',
      'PASS',
      'PASSPHRASE',
      'SECRET',
      'SECRET_KEY',
      'API_KEY',
      'TOKEN',
      'ACCESS_TOKEN',
      'AUTH_TOKEN',
      'CLIENT_SECRET',
      'PRIVATE_KEY',
      'ENCRYPTION_KEY',
    ]
    const failures: string[] = []
    for (let i = 0; i < 400; i++) {
      const word = (n: number) => Array.from({ length: n }, () => pick([...ALPHA])).join('')
      const value = `${word(5 + Math.floor(next() * 6))}${pick(SEP)}${word(4 + Math.floor(next() * 6))}${Math.floor(next() * 90 + 10)}`
      const name = `${pick(PREFIX)}_${pick(SUFFIX)}`
      const [form, make, path] = pick(FORMS)
      const text = make(name, value)
      const a = anonymize(text, { path })
      const seen = [a.anonymized, ...mapped(a), scanSecrets(text, 'redact', { path }).code].join(
        '\n'
      )
      if (pieces(value).test(seen)) failures.push(`#${i} ${form} ${name}=${value} path=${path}`)
      if (!detectSecrets(text, { path }).some((f) => f.length === value.length))
        failures.push(`#${i} not reported: ${form} ${name}=${value} path=${path}`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})

// Research R18: never covered, each needs its own grammar (parked).
describe('engine: environment-style forms not covered yet (R18)', () => {
  it.todo('text with no path, source files, Markdown and text files: unchanged from 1.12.1')
  it.todo('docker run -e DB_PASSWORD=v, and NODE_ENV=prod DB_PASSWORD=v node app.js (mid-line)')
  it.todo('PowerShell $env:DB_PASSWORD, cmd set, fish set -x, setx, Dockerfile ENV DB_PASSWORD v')
  it.todo('the body of a YAML block scalar after DB_PASSWORD: >-')
  it.todo('the Kubernetes pair - name: DB_PASSWORD / value: v')
  it.todo('a quoted value spanning lines whose next line looks like an assignment (NAME= or key:)')
  it.todo('a multi-line quoted value past 16 KB: read to the end of its first line')
  it.todo("the fixed names' own rule past 256 characters with no path, as 1.12.1")
})

describe('engine 1.12.2: security review of ad9d284', () => {
  const leaks = [
    ['a fixed-name value starting with !', 'PGPASSWORD=!Tr0ub4dorZebra91 psql\n', 'run.sh'],
    ['a fixed-name value starting with *', 'POSTGRES_PASSWORD: *Tr0ub4dorZebra91\n', 'compose.yml'],
    // (PGPASSWORD=&x: in shell grammar & is the background operator, as 1.12.1 reads it.)
    ['an anchored YAML value', 'DB_PASSWORD: &pw Tr0ub4dorZebra91\n', 'compose.yml'],
    ['a tagged YAML value', 'DB_PASSWORD: !secret Tr0ub4dorZebra91\n', 'compose.yml'],
    ['a standalone SECRET_KEY (Django)', 'SECRET_KEY=Tr0ub4dorZebra91\n', '.env'],
    ['a standalone PRIVATE_KEY', 'PRIVATE_KEY=Tr0ub4dorZebra91\n', '.env'],
    ['a standalone ACCESS_TOKEN', 'ACCESS_TOKEN: Tr0ub4dorZebra91\n', 'c.yml'],
    ['glued quotes in a shell word', 'export DB_PASSWORD=Tr0ub4dor"Zebra 91"\n', 'a.sh'],
    ['glued single quotes in a shell word', "export DB_PASSWORD=Tr0ub4dor'Zebra 91'\n", 'a.sh'],
    ['an .envrc file', 'export DB_PASSWORD=Tr0ub4dorZebra91\n', '.envrc'],
    ['a .bashrc file', 'export DB_PASSWORD=Tr0ub4dorZebra91\n', '/home/u/.bashrc'],
  ] as const
  for (const [what, text, path] of leaks) {
    it(`${what}: nothing of it reaches output or map`, () => {
      const r = anonymize(text, path === undefined ? {} : { path })
      expect(leaked(r, /Tr0ub4dor|Zebra/), r.anonymized).toBe(false)
    })
  }

  it('an anchor or a tag before the value survives', () => {
    expect(anonymize('DB_PASSWORD: &pw Tr0ub4dorZebra91\n', { path: 'c.yml' }).anonymized).toMatch(
      /^DB_PASSWORD: &\S+ __REDACTED_[A-Z_]+_\d+__\n$/
    )
  })

  it('a quoted shell value stays quoted', () => {
    expect(
      anonymize('export DB_PASSWORD="Tr0ub4dorZebra91"\n', { path: 'a.sh' }).anonymized
    ).toMatch(/^export DB_PASSWORD="__REDACTED_[A-Z_]+_\d+__"\n$/)
  })

  it('PWD, PASS and *_CREDENTIALS still hold paths, not credentials', () => {
    for (const t of [
      'PWD=/Users/x/repo\n',
      'PASS=1\n',
      'GOOGLE_APPLICATION_CREDENTIALS=/etc/sa.json\n',
    ])
      expect(anonymize(t, { path: '.env' }).anonymized, t).not.toMatch(REDACTED)
  })
})

// Research R19: the clients pass the file kind, never the path, so the rules
// reach them while the test-file relaxation stays off.
describe('engine 1.13.0: fileKindOf and the fileKind option', () => {
  it('classifies paths as the engine does', () => {
    const cases: [string, string | undefined][] = [
      ['.env', 'dotenv'],
      ['config/.env.local', 'dotenv'],
      ['.env.production', 'dotenv'],
      ['PROD.ENV', 'dotenv'],
      ['app/settings.env', 'dotenv'],
      ['.env.txt', 'dotenv'],
      ['.env.ini', 'dotenv'],
      ['.env.production~', 'dotenv'],
      ['.env.local backup', 'dotenv'],
      ['src/.env.ts', undefined],
      ['src/.env.js', undefined],
      ['types/.env.d.ts', undefined],
      ['.env.example.json', undefined],
      ['compose.yml', 'yaml'],
      ['k8s/values.YAML', 'yaml'],
      ['deploy.sh', 'shell'],
      ['Dockerfile', 'shell'],
      ['docker/Dockerfile.prod', 'shell'],
      ['/home/u/.bashrc', 'shell'],
      ['.envrc', 'shell'],
      ['src/config.ts', undefined],
      ['README.md', undefined],
    ]
    for (const [path, kind] of cases) expect(fileKindOf(path), path).toBe(kind)
  })

  it('fileKind alone (no path) turns the rules on, for every entry point', () => {
    const text = 'DB_PASSWORD=Tr0ub4dor zebra91\n'
    const r = anonymize(text, { fileKind: 'dotenv' })
    expect(leaked(r, /Tr0ub4dor|zebra91/), r.anonymized).toBe(false)
    expect(scanSecrets(text, 'redact', { fileKind: 'dotenv' }).code).not.toMatch(
      /Tr0ub4dor|zebra91/
    )
    expect(detectSecrets(text, { fileKind: 'dotenv' }).length).toBeGreaterThan(0)
    expect(credentialSpans(text, { fileKind: 'dotenv' }).length).toBeGreaterThan(0)
    expect(
      leaked(anonymize('API_TOKEN: Tr0ub4dor zebra91\n', { fileKind: 'yaml' }), /zebra91/)
    ).toBe(false)
    expect(
      leaked(anonymize('export DB_PASSWORD=Tr0ub4dorZebra91\n', { fileKind: 'shell' }), /Zebra91/)
    ).toBe(false)
  })

  it('without a fileKind or a path, nothing changes from 1.12.1', () => {
    expect(anonymize('DB_PASSWORD=Tr0ub4dor zebra91\n', {}).anonymized).not.toMatch(REDACTED)
  })

  it('an explicit fileKind wins over the kind a path implies', () => {
    const r = anonymize('DB_PASSWORD=Tr0ub4dor zebra91\n', { path: 'a.ts', fileKind: 'dotenv' })
    expect(leaked(r, /zebra91/)).toBe(false)
  })

  it('fileKind never relaxes a test file: a weak fixed-name value is still redacted', () => {
    expect(anonymize('PGPASSWORD=postgres\n', { fileKind: 'dotenv' }).anonymized).toMatch(REDACTED)
  })

  it('a ` # comment` after an empty value is not a value', () => {
    expect(anonymize('DB_PASSWORD= # set in vault\n', { path: '.env' }).anonymized).not.toMatch(
      REDACTED
    )
    expect(anonymize('DB_PASSWORD: # TODO fill in\n', { path: 'c.yml' }).anonymized).not.toMatch(
      REDACTED
    )
  })

  it('a .env.ts source file is code, not dotenv', () => {
    expect(
      anonymize('secret = config.secretValue\n', { path: 'src/.env.ts' }).anonymized
    ).not.toMatch(REDACTED)
  })
})

describe('engine 1.13.0: a # right after = is a value', () => {
  it('DB_PASSWORD=#abc… is redacted; an anchor then a comment is not a value', () => {
    expect(
      leaked(anonymize('DB_PASSWORD=#Tr0ub4dorZebra91\n', { path: '.env' }), /Tr0ub4dor/)
    ).toBe(false)
    expect(anonymize('DB_PASSWORD: &pw # later\n', { path: 'c.yml' }).anonymized).not.toMatch(
      REDACTED
    )
  })
})

describe('engine 1.13.0: review of 8c38100', () => {
  it('the fixed-name rule redacts a quoted or = value starting with > or |, as on 1.12.1', () => {
    for (const t of [
      'PGPASSWORD=">12345"\n',
      "PGPASSWORD='|'\n",
      "PGPASSWORD='>-'\n",
      'PGPASSWORD=>5\n',
      'PGPASSWORD: "|2"\n',
      'MYSQL_PWD=">+9" mysql\n',
    ])
      expect(anonymize(t, {}).anonymized, t).toMatch(REDACTED)
  })

  it('an unknown fileKind is refused, by name', () => {
    expect(() => anonymize('x', { fileKind: 'env' as never })).toThrow(/fileKind/)
    expect(() => scanSecrets('x', 'redact', { fileKind: 'DOTENV' as never })).toThrow(/fileKind/)
  })

  it("an explicit fileKind adds to the path's kind, never replaces it", () => {
    const r = anonymize('DB_PASSWORD=Xk9#mQ2vLp8zRt4w\n', { path: '.env', fileKind: 'yaml' })
    expect(leaked(r, /Xk9|mQ2vLp8zRt4w/), r.anonymized).toBe(false)
  })

  it('column-aligned YAML: any spacing around the colon', () => {
    for (const t of [
      'DB_PASSWORD:    Xk9mQ2vLp8zRt4wq\n',
      'DB_PASSWORD:\t\t\t\tXk9mQ2vLp8zRt4wq\n',
      'DB_PASSWORD    : Xk9mQ2vLp8zRt4wq\n',
    ])
      expect(leaked(anonymize(t, { fileKind: 'yaml' }), /Xk9mQ2vLp8zRt4wq/), t).toBe(false)
  })

  it('a unified-diff line (+, - or space first) is read as the line it holds', () => {
    for (const [t, k] of [
      ['-      API_TOKEN: Summer2024\n', 'yaml'],
      ['+      API_TOKEN: Autumn2025\n', 'yaml'],
      ['+DB_PASSWORD=Tr0ub4dor zebra91\n', 'dotenv'],
      ['-export DB_PASSWORD=Tr0ub4dorZebra91\n', 'shell'],
    ] as const) {
      const r = anonymize(t, { fileKind: k })
      expect(r.anonymized, t).toMatch(/^[+-]/)
      expect(leaked(r, /Summer2024|Autumn2025|Tr0ub4dor|zebra91|Zebra91/), r.anonymized).toBe(false)
    }
  })
})

describe('engine 1.13.0: quoted values of any length, unclosed quotes (security review of 11f2d20)', () => {
  const long = Array.from({ length: 700 }, (_, i) => `q${i}z`).join('-')
  const cases = [
    ['a double-quoted dotenv value over 256 characters', `DB_PASSWORD="${long}"\n`, 'dotenv'],
    [
      'a single-quoted dotenv value over 4096 characters',
      `DB_PASSWORD='${long}${long}'\n`,
      'dotenv',
    ],
    ['a double-quoted YAML value over 256 characters', `DB_PASSWORD: "${long}"\n`, 'yaml'],
    ['a single-quoted YAML value with an escaped quote', `DB_PASSWORD: 'q1z''${long}'\n`, 'yaml'],
    ['a double-quoted YAML value with an escape', `DB_PASSWORD: "q1z\\"${long}"\n`, 'yaml'],
    [
      'a quoted compose item over 4096 characters',
      `environment:\n  - "DB_PASSWORD=${long}${long}"\n`,
      'yaml',
    ],
    ['an unclosed double quote in dotenv', `DB_PASSWORD="${long}\n`, 'dotenv'],
    ['an unclosed single quote in YAML', `DB_PASSWORD: '${long}\n`, 'yaml'],
  ] as const
  for (const [what, text, kind] of cases) {
    it(`${what}: nothing of it reaches output or map`, () => {
      expect(leaked(anonymize(text, { fileKind: kind }), /q699z|q350z|q1z/)).toBe(false)
    })
  }
})

describe('engine 1.13.0: a long quoted value keeps its quotes', () => {
  it('the closing quote stays', () => {
    const long = Array.from({ length: 700 }, (_, i) => `q${i}z`).join('-')
    expect(anonymize(`DB_PASSWORD="${long}"\n`, { fileKind: 'dotenv' }).anonymized).toMatch(
      /^DB_PASSWORD="__REDACTED_[A-Z_]+_\d+__"\n$/
    )
    expect(anonymize(`DB_PASSWORD: '${long}'\n`, { fileKind: 'yaml' }).anonymized).toMatch(
      /^DB_PASSWORD: '__REDACTED_[A-Z_]+_\d+__'\n$/
    )
  })
})

describe('engine 1.13.0: escaped and multi-line quoted values (security review of 1bde3ab)', () => {
  const cases = [
    [
      'an escaped quote in a dotenv value',
      'DB_PASSWORD="Tr0ub4dor\\"zebra91 quokka77"\n',
      'dotenv',
    ],
  ] as const
  for (const [what, text, kind] of cases) {
    it(`${what}: nothing of it reaches output or map`, () => {
      const r = anonymize(text, { fileKind: kind })
      expect(leaked(r, /Tr0ub4dor|zebra91|quokka77/), r.anonymized).toBe(false)
    })
  }
})

describe('engine 1.13.0: review of f26b887', () => {
  it('no path: a fixed name in minified code takes no more than 1.12.1 took', () => {
    const fields = Array.from({ length: 80 }, (_, i) => `f${i}:e.f${i}`).join(',')
    const r = anonymize(`x={MYSQL_PWD:e.pwd,${fields},z:1}\n`, {})
    expect(r.anonymized).toMatch(/,z:1\}\n$/)
  })

  it('no path: > with digits is a value, only a real YAML block header is not', () => {
    for (const t of ['MYSQL_PWD: >20241028\n', 'PGPASSWORD: >1234\n'])
      expect(anonymize(t, {}).anonymized, t).toMatch(REDACTED)
    for (const t of [
      'env:\n  POSTGRES_PASSWORD: >-\n    x\n',
      'env:\n  POSTGRES_PASSWORD: |2\n    x\n',
      'env:\n  POSTGRES_PASSWORD: >+1\n    x\n',
    ])
      expect(anonymize(t, { fileKind: 'yaml' }).anonymized.split('\n')[1], t).not.toMatch(REDACTED)
  })

  it('an unclosed quote takes its own line only; the next lines are read as usual', () => {
    const r = anonymize("API_TOKEN='abc\nDATABASE_URL=postgres://db/app\nDEBUG='1'\n", {
      fileKind: 'dotenv',
    })
    expect(r.anonymized).toMatch(/\nDATABASE_URL=\S+\nDEBUG='1'\n$/)
    const y = anonymize('API_TOKEN: "C:\\keys\\"\nhost: db\nport: "5432"\n', { fileKind: 'yaml' })
    expect(y.anonymized).toMatch(/\n\S+: \S+\n\S+: "5432"\n$/)
  })

  it('a shell command substitution with nested quotes is not a value', () => {
    for (const t of [
      'PASSWORD="$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)"\n',
      'TOKEN="$(cat "$HOME/.token")"\n',
      'TOKEN=`cat ~/.token`\n',
    ])
      expect(anonymize(t, { fileKind: 'shell' }).anonymized, t).not.toMatch(REDACTED)
  })

  it('a key file path is not a value', () => {
    for (const [t, k] of [
      ['JWT_PRIVATE_KEY=./keys/jwt-private.pem\n', 'dotenv'],
      ['TLS_PRIVATE_KEY=/etc/ssl/private/server.key\n', 'dotenv'],
      ['SSH_PRIVATE_KEY=~/.ssh/id_ed25519\n', 'dotenv'],
      ['export GPG_PRIVATE_KEY=$HOME/.gnupg/key.asc\n', 'shell'],
      ['export SIGNING_KEY=${PWD}/certs/sign.pem\n', 'shell'],
      ['SIGNING_KEY: /run/secrets/signing.pem\n', 'yaml'],
    ] as const)
      expect(anonymize(t, { fileKind: k }).anonymized, t).not.toMatch(REDACTED)
  })

  it('booleans, short numbers and null are not reported under a convention name', () => {
    for (const t of [
      'USE_API_KEY=false\n',
      'MAX_TOKEN=4096\n',
      'REQUIRE_PASSWORD=yes\n',
      'PASSWORD=on\n',
    ])
      expect(detectSecrets(t, { fileKind: 'dotenv' }), t).toEqual([])
    expect(detectSecrets('API_KEY: ~\n', { fileKind: 'yaml' })).toEqual([])
  })

  it('fileKindOf: code files are never dotenv or shell', () => {
    for (const p of [
      'tools/dockerfile.py',
      'Dockerfile.test.ts',
      '.env.rs',
      '.env.swift',
      '.env.lua',
      '.env.md',
    ])
      expect(fileKindOf(p), p).toBeUndefined()
    for (const p of ['Dockerfile', 'Dockerfile.prod', 'docker/Dockerfile.dev'])
      expect(fileKindOf(p), p).toBe('shell')
  })

  it('an indented YAML list item - NAME: v', () => {
    const r = anonymize('env:\n  - DB_PASSWORD: Xk9mQ2vL7pZq\n', { fileKind: 'yaml' })
    expect(leaked(r, /Xk9mQ2vL7pZq/)).toBe(false)
  })
})

describe('engine 1.13.0: security review of 2bc28d4', () => {
  it('a value starting with / is a path only when it reads as one', () => {
    for (const t of ['DB_PASSWORD=/Tr0ub4dor!zebra#91\n', 'API_TOKEN=/xK9mQ2vL7pZq\n'])
      expect(leaked(anonymize(t, { fileKind: 'dotenv' }), /Tr0ub4dor|xK9mQ2vL7pZq/), t).toBe(false)
    for (const t of ['SIGNING_KEY=/run/secrets/sign\n', 'JWT_PRIVATE_KEY=/keys/jwt.pem\n'])
      expect(anonymize(t, { fileKind: 'dotenv' }).anonymized, t).not.toMatch(REDACTED)
  })

  it('a closed quote spans lines until a line starts a new assignment', () => {
    const ml = anonymize('DB_PASSWORD="Tr0ub4dor\nzebra91\nquokka77"\nAPP=1\n', {
      fileKind: 'dotenv',
    })
    expect(leaked(ml, /Tr0ub4dor|zebra91|quokka77/), ml.anonymized).toBe(false)
    expect(ml.anonymized).toMatch(/\nAPP=1\n$/)
    const y = anonymize('DB_PASSWORD: "Tr0ub4dor\n  zebra91 quokka77"\nother: 1\n', {
      fileKind: 'yaml',
    })
    expect(leaked(y, /Tr0ub4dor|zebra91|quokka77/), y.anonymized).toBe(false)
    const stray = anonymize("API_TOKEN='abc\nDATABASE_URL=postgres://db/app\nDEBUG='1'\n", {
      fileKind: 'dotenv',
    })
    expect(stray.anonymized).toMatch(/\nDATABASE_URL=\S+\nDEBUG='1'\n$/)
  })

  it('in a shell file a fixed name takes a long value whole', () => {
    const long = Array.from({ length: 700 }, (_, i) => `q${i}z`).join('-')
    const r = anonymize(`export PGPASSWORD=${long}\npsql\n`, { fileKind: 'shell' })
    expect(leaked(r, /q699z|q350z/)).toBe(false)
  })
})
