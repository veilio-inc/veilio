import { describe, it, expect } from 'vitest'
import { hasBlockingSecrets, isExamplePath, scanSecrets } from '../src/secrets.js'

// Code review of PR #166 at 9c765c1. One block per finding, numbered as in the
// review. `§` stands where the secret is; the scan must replace exactly that.

const TOKEN = /__REDACTED_[A-Z_]+_\d+__/
const b64 = (text: string) => Buffer.from(text).toString('base64')
const opts = (path?: string) => (path === undefined ? {} : { path })

function redacted(template: string, secret: string, path?: string) {
  const code = template.replace('§', secret)
  const out = scanSecrets(code, 'redact', opts(path)).code
  const [before, after] = template.split('§')
  expect(out, code).toMatch(new RegExp(`^${escape(before)}${TOKEN.source}${escape(after)}$`))
}
function untouched(code: string, path?: string) {
  const scan = scanSecrets(code, 'redact', opts(path))
  expect(scan.code, code).toBe(code)
  return scan
}
function nothing(code: string, path?: string) {
  expect(untouched(code, path).findings, code).toEqual([])
}
function reportedOnly(code: string, path: string) {
  const scan = untouched(code, path)
  expect(scan.findings.length, code).toBeGreaterThan(0)
  expect(scan.findings.every((f) => f.disposition === 'report')).toBe(true)
  expect(hasBlockingSecrets(scan.findings)).toBe(false)
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('1. mysql -p: only the attached form is a password', () => {
  it('-pVALUE is redacted for every mysql-family client', () => {
    for (const client of ['mysql', 'mysqldump', 'mariadb', 'mariadb-dump', 'mysqladmin']) {
      redacted(`${client} -u root -p§ shop`, 'Summer24')
    }
  })
  it('-p <word> is the database name and is left alone', () => {
    nothing('mysql -u root -p shop')
    nothing('mysql -u root -p Summer24')
    nothing('mariadb -h db -p app_db')
    nothing('mysqldump -u root -p --all-databases')
  })
  it('-p <value> with a space is a password for the tools that take one', () => {
    redacted('sshpass -p § ssh deploy@host', 'Summer24')
    redacted('mongosh -u admin -p § --authenticationDatabase admin', 'Summer24')
    redacted('mongodump -u admin -p § --out dump', 'Summer24')
  })
})

describe('2. a user:pass pair is judged half by half', () => {
  const PATH = 'tests/db.test.ts'
  it('the password half alone decides the test-file downgrade', () => {
    reportedOnly('postgres://admin:Summer24@db/app', PATH)
    reportedOnly('PGPASSWORD=Summer24 psql', PATH)
    reportedOnly(`Authorization: Basic ${b64('admin:Summer24')}`, PATH)
    reportedOnly('curl -u admin:Summer24 https://api', PATH)
  })
  it('a strong password half is redacted in a test file', () => {
    redacted('postgres://admin:§@db/app', 'Xk9#mQ2vL7pZ', PATH)
    redacted('curl -u admin:§ https://api', 'Xk9#mQ2vL7pZ', PATH)
  })
})

describe('3. a user half is redacted only when it is token-shaped', () => {
  it('plain user names stay, in source and in tests', () => {
    for (const user of ['deploy_user_2024', 'Build-Agent01', 'x-access-token']) {
      for (const path of [undefined, 'src/a.ts', 'tests/a.test.ts']) {
        const url = untouched(`https://${user}@git.example.com/r`, path)
        expect(
          url.findings.filter((f) => f.type !== 'email'),
          user
        ).toEqual([])
        const curl = scanSecrets(`curl -u ${user}:x https://api`, 'redact', opts(path)).code
        expect(curl, user).toContain(`-u ${user}:`)
      }
    }
  })
  it('a GitHub PAT or a Stripe key as the user is redacted in every file', () => {
    const pat = 'ghp_016C7e42F292c6912E7710c838347Ae178B4a'
    const stripe = 'sk_live_51H8xQ2ABCDEFGHIJKLMNOP'
    for (const path of [undefined, 'src/a.ts', 'tests/a.test.ts', '.env.example']) {
      redacted('https://§@github.com/org/repo', pat, path)
      redacted('https://§:@api.example.com/v1', stripe, path)
      expect(scanSecrets(`curl -u ${stripe}: https://api`, 'redact', opts(path)).code).toMatch(
        new RegExp(`^curl -u ${TOKEN.source}: https://api$`)
      )
      redacted('Authorization: Basic §', b64(`${stripe}:`), path)
    }
  })
  it('a high-entropy token as the user is redacted in every file', () => {
    for (const path of [undefined, 'tests/a.test.ts']) {
      redacted('https://§@git.example.com/r', 'a3f9c2e1b7d04f6e9a8b7c6d', path)
      redacted('Authorization: Basic §', b64('a3f9c2e1b7d04f6e9a8b7c6d:x'), path)
    }
  })
  it('a strong but not token-shaped Basic user does not keep a weak pair redacted', () => {
    reportedOnly(`Authorization: Basic ${b64('Build-Agent01:Summer24')}`, 'tests/a.test.ts')
  })
})

describe('4. placeholders that span spaces are whole', () => {
  const cases = [
    '$ deploy --password ${{ secrets.DB_PASSWORD }}',
    '$ deploy --password=${{ secrets.DB_PASSWORD }}',
    'PGPASSWORD=<your password> psql',
    'POSTGRES_PASSWORD: {{ db_password }}',
    '  POSTGRES_PASSWORD: ${{ secrets.PG }}',
    'X-Api-Key: ${{ secrets.API_KEY }}',
    'X-Api-Key: <your api key>',
    'mongosh -u admin -p <your password>',
    'mongosh -u admin -p {{ mongo_password }}',
    'mysql -u root -p"<your password>"',
    'PGPASSWORD="${{ secrets.PG }}" psql',
  ]
  for (const code of cases) {
    it(`leaves ${JSON.stringify(code)} alone`, () => nothing(code))
  }
})

describe('5. --password counts only in a command context', () => {
  const prose = [
    'Pass --password to set the database password.',
    'Use --password for the admin account.',
    'The --password is required in CI.',
    '  --password TEXT  The database password.',
    '  --password PASSWORD  password to use (default: none)',
    '  --password=PASSWORD  password to use',
    '  -p, --pass TEXT      Password.',
    '> Use --password to set it.',
    '$ deploy --password PASSWORD',
    '$ deploy --password <password>',
    '$ deploy --password --host db',
    'mongosh -u admin -p --host db',
  ]
  for (const code of prose) {
    it(`prose or help text: ${JSON.stringify(code)}`, () => {
      nothing(code)
      for (const path of ['README.md', 'docs/cli.mdx', 'HELP.txt', 'man/deploy.1', 'guide.rst']) {
        nothing(code, path)
      }
    })
  }
  const commands: [string, string?][] = [
    ['$ deploy --password §'],
    ['> deploy --password §'],
    ['psql --password=§ -h db'],
    ['docker login --password § registry'],
    ['./deploy.sh --password=§'],
    ['bin/deploy --password=§'],
    ['  run: ./deploy.sh --password=§'],
    ['RUN deploy-tool --password=§ || true', undefined],
    ['sudo mysql --password=§'],
    ['FOO=1 ./deploy --password §'],
    ['args: ["--password=§"]'],
  ]
  for (const [template] of commands) {
    it(`command: ${template}, also in a prose file`, () => {
      redacted(template, 'hunter22')
      redacted(template, 'hunter22', 'README.md')
    })
  }
  it('an argv element in single quotes, in a prose file', () => {
    redacted("args: ['--password=§']", 'hunter22', 'README.md')
  })
  it('a continued command line in a prose file', () => {
    redacted('docker login \\\n  --username me \\\n  --password §', 'hunter22', 'README.md')
  })
  it('inside a code fence', () => {
    for (const fence of ['```sh', '```bash', '```', '~~~console']) {
      const close = fence.startsWith('~') ? '~~~' : '```'
      const code = `Run it:\n\n${fence}\ndeploy --password hunter22\n${close}\n`
      const out = scanSecrets(code, 'redact', { path: 'README.md' }).code
      expect(out, fence).toMatch(new RegExp(`deploy --password ${TOKEN.source}\\n`))
    }
    // A fence closes only on its own marker.
    expect(
      scanSecrets('```sh\n~~~\ndeploy --password hunter22\n```\n', 'redact', { path: 'README.md' })
        .code
    ).toMatch(new RegExp(`deploy --password ${TOKEN.source}\\n`))
    // After the fence closes it is prose again.
    nothing('```sh\nls\n```\ndeploy --password hunter22\n', 'README.md')
  })
  it('in a shell script file, every line is a command', () => {
    redacted('deploy --password §', 'hunter22', 'scripts/deploy.sh')
    nothing('deploy --password hunter22', 'docs/deploy.md')
  })
})

describe('6. isExamplePath counts only folders inside the project', () => {
  it('an absolute path does not count the folders above the project', () => {
    expect(isExamplePath('/home/test/app/src/db.ts')).toBe(false)
    expect(isExamplePath('/home/test/app/src/db.ts', '/home/test/app')).toBe(false)
    expect(isExamplePath('/srv/examples/app/src/db.ts')).toBe(false)
    expect(isExamplePath('C:\\Users\\test\\app\\src\\db.ts')).toBe(false)
  })
  it('with a root, the folders inside it count', () => {
    expect(isExamplePath('/repo/tests/db.ts', '/repo')).toBe(true)
    expect(isExamplePath('/repo/tests/db.ts', '/repo/')).toBe(true)
    expect(isExamplePath('C:\\repo\\tests\\db.ts', 'C:\\repo')).toBe(true)
    expect(isExamplePath('/home/test/app/tests/db.ts', '/home/test/app')).toBe(true)
  })
  it('the file name counts wherever the file is', () => {
    expect(isExamplePath('/home/u/app/src/db.test.ts')).toBe(true)
    expect(isExamplePath('/home/u/app/.env.example')).toBe(true)
  })
  it('a root that does not contain the path counts no folders', () => {
    expect(isExamplePath('/other/tests/db.ts', '/repo')).toBe(false)
    expect(isExamplePath('/repository/tests/db.ts', '/repo')).toBe(false)
  })
  it('scanSecrets takes the root', () => {
    const code = 'PGPASSWORD=Summer24 psql'
    const inside = scanSecrets(code, 'redact', { path: '/repo/tests/db.ts', root: '/repo' })
    expect(inside.code).toBe(code)
    expect(hasBlockingSecrets(inside.findings)).toBe(false)
    // Without the root the folders of an absolute path do not count.
    expect(scanSecrets(code, 'redact', { path: '/repo/tests/db.ts' }).code).toMatch(TOKEN)
  })
})

describe('7. the context verdict survives an overlapping generic rule', () => {
  const PATH = 'tests/db.test.ts'
  it('a quoted weak value in a test file is report-only', () => {
    reportedOnly('PGPASSWORD="Summer24" psql', PATH)
    reportedOnly('POSTGRES_PASSWORD: "Summer24"', PATH)
    reportedOnly('$ deploy --password="Summer24"', PATH)
    reportedOnly('"X-Api-Key": "Summer24"', PATH)
  })
  it('the same text in source is redacted', () => {
    redacted('PGPASSWORD="§" psql', 'Summer24', 'src/db.ts')
  })
  it('a provider-shaped weak password in a test file is still redacted, as the provider key', () => {
    const out = scanSecrets('PGPASSWORD=sk_live_aaaabbbbcc psql', 'redact', { path: PATH })
    expect(out.code).toBe('PGPASSWORD=__REDACTED_STRIPE_KEY_1__ psql')
  })

  it('a provider key still wins over the context verdict', () => {
    const out = scanSecrets('PGPASSWORD="sk_live_51H8xQ2ABCDEFGHIJKLMNOP"', 'redact', {
      path: PATH,
    })
    expect(out.code).toBe('PGPASSWORD="__REDACTED_STRIPE_KEY_1__"')
  })
})

describe('8. a backslash-continued command is one command', () => {
  it('catches -p on a continuation line', () => {
    redacted('mysql \\\n  -u root \\\n  -p§ db', 'Summer24')
    redacted('sqlcmd -S db \\\n  -U sa \\\n  -P §', 'Summer24')
    redacted('curl -s \\\n  -u admin:§ \\\n  https://api', 'Summer24')
  })
  it('--password on a continuation line of a command', () => {
    redacted('docker login \\\n  --username me \\\n  --password §', 'Summer24')
  })
  it('a line that does not end in a backslash ends the command', () => {
    nothing('mysql -u root\n-pSummer24 db')
  })
})

describe('9. X-Api-Key followed by code is left alone', () => {
  for (const code of [
    'X-Api-Key: process.env.API_KEY',
    "X-Api-Key: os.environ['API_KEY']",
    'X-Api-Key: os.environ.get("API_KEY")',
    'X-Api-Key: config.key',
    'X-Api-Key: ${API_KEY}',
    'X-Api-Key: $API_KEY',
  ]) {
    it(JSON.stringify(code), () => nothing(code))
  }
  it('a literal value is a key', () => {
    redacted('X-Api-Key: §', 'abcd1234')
    redacted('X-Api-Key: §', 'k3y-1234_ABCD')
  })
})

describe('10. ${VAR:-default}: the default is the value', () => {
  for (const template of [
    'PGPASSWORD=${PG_PASS:-§} psql',
    'PGPASSWORD=${PG_PASS-§} psql',
    'PGPASSWORD=${PG_PASS:=§} psql',
    'PGPASSWORD="${PG_PASS:-§}" psql',
    '$ deploy --password=${DEPLOY_PW:-§}',
  ]) {
    it(template, () => redacted(template, 'Summer24'))
  }
  for (const code of [
    'PGPASSWORD=${PG_PASS} psql',
    'PGPASSWORD=${PG_PASS:?set PG_PASS} psql',
    'PGPASSWORD=${PG_PASS:-} psql',
    'PGPASSWORD=${PG_PASS:-changeme} psql',
    'password = "${DB_PASS:-changeme}"',
  ]) {
    it(`placeholder: ${code}`, () => nothing(code))
  }
  it('a weak default in a test file is report-only', () => {
    reportedOnly('PGPASSWORD=${PG_PASS:-Summer24} psql', 'tests/db.test.ts')
  })
})

// Security review of the review round: the command-context exemption let a
// password through in source code, where the command sits in a string.
describe('second review, 1: the prose exemption applies only to prose', () => {
  const SOURCES: [string, string][] = [
    ['exec("mysql --password §mysqldb")', 'src/db.ts'],
    ['subprocess.run(["mysql", "--password", "§"])', 'tools/backup.py'],
    ["subprocess.run(['mysql', '--password', '§'])", 'tools/backup.py'],
    ['const cmd = `psql --password=§ -h ${host}`', 'src/db.ts'],
    ['args: ["--password", "§"]', 'deploy/values.yaml'],
    ['subprocess.run(["mysql", "-uroot", "-p§"])', 'tools/backup.py'],
  ]
  for (const [template, path] of SOURCES) {
    it(`${template} in ${path}, and with no path`, () => {
      const secret = 'hunter22'
      const t = template.replace('§mysqldb', '§ db')
      redacted(t, secret, path)
      redacted(t, secret)
    })
  }
  it('in source a metavar-looking value is judged as a password', () => {
    redacted('run("deploy --password §")', 'TEXT', 'src/cli.ts')
    redacted('deploy --password §', 'HUNTER2X', 'scripts/deploy.sh')
  })
  it('with no path, a bare command is a password unless the value is prose-like', () => {
    redacted('deploy --password §', 'hunter22')
    nothing('Use --password for the admin account.')
  })
  it('in a prose file, quoted code on a line is judged as code', () => {
    redacted('Call `exec("deploy --password §")` from a script.', 'hunter22', 'README.md')
  })
  it('a short flag that is its own argv element takes only a bare value', () => {
    // The quote after the flag closes its element; it does not open a value.
    nothing("run(command('redis-cli') + '-a')", 'src/a.ts')
    nothing('spawn("sshpass", ["-p", user])', 'src/a.ts')
    redacted('spawn("redis-cli", ["-a§"])', 'hunter22', 'src/a.ts')
  })

  it('an ellipsis is a placeholder', () => {
    nothing('$ deploy --password …')
    nothing('exec("mysql --password ... db")', 'src/a.ts')
  })

  it('a placeholder template in source stays a placeholder', () => {
    nothing('const cmd = `psql --password=${pw} -h db`', 'src/db.ts')
  })
})

describe('second review, 2: only a generic match inside the fixture is dropped', () => {
  it('a generic match that extends past the fixture is redacted', () => {
    const code = 'db_password = "postgres://app:Summer24@db/app"'
    const scan = scanSecrets(code, 'redact', { path: 'tests/x.test.ts' })
    expect(scan.code).toMatch(new RegExp(`^db_password = "${TOKEN.source}"$`))
  })
  it('a generic match with the fixture span is dropped', () => {
    reportedOnly('PGPASSWORD="Summer24" psql', 'tests/x.test.ts')
  })
})

describe('second review, 3: only a closed list of metavars', () => {
  for (const value of ['HUNTER2X', 'SUMMER2024', 'ADMIN']) {
    it(`--password ${value} is a password, even in a prose file`, () => {
      redacted('$ deploy --password §', value, 'README.md')
      redacted('$ deploy --password §', value)
    })
  }
  for (const metavar of [
    'PASSWORD',
    'PASS',
    'PASSWD',
    'PWD',
    'TEXT',
    'VALUE',
    'SECRET',
    'STRING',
    'TOKEN',
    'KEY',
    '[PASSWORD]',
    '<pw>',
  ]) {
    it(`--password ${metavar} is a metavar in prose`, () => {
      nothing(`  --password ${metavar}  The password.`, 'README.md')
      nothing(`  --password ${metavar}  The password.`)
    })
  }
  it('to/for/is are prose only in prose', () => {
    nothing('Pass --password to the tool.', 'README.md')
    redacted('run("deploy --password §")', 'to', 'src/a.ts')
  })
})

describe('second review, 4: a header value is code only from a known code root', () => {
  for (const code of [
    'X-Api-Key: process.env.API_KEY',
    "X-Api-Key: os.environ['API_KEY']",
    'X-Api-Key: os.getenv("API_KEY")',
    "X-Api-Key: ENV['API_KEY']",
    'X-Api-Key: config.apiKey',
    'X-Api-Key: settings.API_KEY',
    'X-Api-Key: secrets.API_KEY',
    'X-Api-Key: import.meta.env.VITE_KEY',
    'X-Api-Key: ${API_KEY}',
    'X-Api-Key: $API_KEY',
    'X-Api-Key: {{ api_key }}',
  ]) {
    it(`left alone: ${code}`, () => nothing(code))
  }
  for (const value of ['abc.def', 'abcd.efgh.ijkl', 'key(1234)', 'ab[cd]ef', 'getKey()']) {
    it(`redacted: X-Api-Key: ${value}`, () => redacted('X-Api-Key: §', value))
  }
  it('a JWT whose payload is not JSON is still a credential in a header', () => {
    redacted('X-Api-Key: §', 'eyJhbGciOiJub25lIn0.cGF5bG9hZA.c2lnbmF0dXJl')
  })

  it('a JWT is a credential in a header', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    redacted('X-Api-Key: §', jwt)
    redacted('Authorization: Bearer §', 'abcd.efgh.ijkl')
  })
})
