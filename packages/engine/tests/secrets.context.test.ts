import { describe, it, expect } from 'vitest'
import {
  detectSecrets,
  hasBlockingSecrets,
  isExamplePath,
  scanSecrets,
  type SecretType,
} from '../src/secrets.js'
import { anonymize, restore } from '../src/engine.js'

// Spec 013 (founder decisions 5 and 6, 2026-10-26): a password in a secret
// position is removed whatever its strength, and a weak one is only reported
// in a test, fixture or example file.
//
// Each case is a template: `§` stands where the secret is. The scan must
// replace exactly that span and nothing else, so the user, the host, the flag
// and the variable name are all checked to survive.

const TOKEN = /__REDACTED_[A-Z_]+_\d+__/

function expectRedacted(template: string, secret: string, path?: string, type?: SecretType) {
  const code = template.replace('§', secret)
  const scan = scanSecrets(code, 'redact', path === undefined ? undefined : { path })
  const at = template.indexOf('§')
  const before = template.slice(0, at)
  const after = template.slice(at + 1)
  expect(scan.code.startsWith(before), `${code}: kept prefix`).toBe(true)
  expect(scan.code.endsWith(after), `${code}: kept suffix`).toBe(true)
  const middle = scan.code.slice(before.length, scan.code.length - after.length)
  expect(middle, `${code}: replaced span`).toMatch(new RegExp(`^${TOKEN.source}$`))
  expect(hasBlockingSecrets(scan.findings)).toBe(true)
  if (type) expect(scan.findings.map((f) => f.type)).toContain(type)
}

function expectUntouched(code: string, path?: string) {
  const scan = scanSecrets(code, 'redact', path === undefined ? undefined : { path })
  expect(scan.code, code).toBe(code)
  return scan
}

function expectNothing(code: string, path?: string) {
  const scan = expectUntouched(code, path)
  expect(scan.findings, code).toEqual([])
}

function expectReportedOnly(code: string, path: string) {
  const scan = expectUntouched(code, path)
  expect(scan.findings.length, `${code} at ${path}: a finding`).toBeGreaterThan(0)
  expect(scan.findings.every((f) => !f.redacted && f.disposition === 'report')).toBe(true)
  expect(hasBlockingSecrets(scan.findings)).toBe(false)
  expect(scan.findings.map((f) => f.type)).toContain('possible-credential')
}

describe('password flags on a command line', () => {
  const positives: [string, string][] = [
    ['mysql -u root -p§ shop', 'hunter22'],
    ['mysql -uroot -p§', 'secret1'],
    ['mysqldump -h db -u app -p§ --all-databases', 'pass'],
    ['mariadb -u root -p § shop', 'hunter22'],
    ['mysql -u root -p"§" shop', 'two words'],
    ["mysql -u root -p'§'", 'abc;def'],
    ['mongosh -u admin -p § --authenticationDatabase admin', 'mongo123'],
    ['sshpass -p § ssh deploy@host', 'letmein'],
    ['sqlcmd -S db -U sa -P §', 'Passw0rd'],
    ['bcp dbo.t out t.dat -S db -U sa -P§', 'Passw0rd'],
    ['ipmitool -I lanplus -H 10.0.0.9 -U admin -P § chassis status', 'calvin'],
    ['redis-cli -h cache -a § ping', 'redispass'],
    ['psql --password=§ -h db', 'hunter22'],
    ['some-tool --password § --verbose', 'hunter22'],
    ['some-tool --pass=§', 'hunter22'],
    ['openssl pkcs12 --passwd "§" -in x', 'with space'],
    ['  run: deploy --password=§', 'ci-pass'],
  ]
  for (const [template, secret] of positives) {
    it(`redacts the password in ${template}`, () => {
      expectRedacted(template, secret, undefined, 'password-assignment')
    })
  }

  const negatives = [
    'mysql -h db -P 3306 -u root -p',
    'mysql -h db -P3306 -u root',
    'Port flags (`mysql -P 3306`, `psql -p 5432`, `ssh -p 22`)',
    'mysql -u root -p\nshop',
    'psql -p 5432 -h db',
    'ssh -p 22 deploy@host',
    'scp -P 2222 file host:',
    'docker run -p 8080:80 nginx',
    'mkdir -p build/out',
    'cp -p a b',
    'redis-cli -p 6380 ping',
    'docker login --password-stdin -u me',
    'tool --password-file ./pw.txt',
    'psql --no-password -h db',
    'psql --no-password shop',
    'tool --password --host db',
    'tool --passphrase-file key',
  ]
  for (const code of negatives) {
    it(`leaves ${JSON.stringify(code)} alone`, () => {
      expectNothing(code)
    })
  }
})

describe('password environment variables', () => {
  const names = [
    'PGPASSWORD',
    'MYSQL_PWD',
    'MYSQL_PASSWORD',
    'MYSQL_ROOT_PASSWORD',
    'MARIADB_PASSWORD',
    'MARIADB_ROOT_PASSWORD',
    'POSTGRES_PASSWORD',
    'MONGO_INITDB_ROOT_PASSWORD',
    'RABBITMQ_DEFAULT_PASS',
    'MSSQL_SA_PASSWORD',
    'SA_PASSWORD',
    'SQLCMDPASSWORD',
    'REDISCLI_AUTH',
    'SSHPASS',
    'ELASTIC_PASSWORD',
    'KEYCLOAK_ADMIN_PASSWORD',
    'KC_BOOTSTRAP_ADMIN_PASSWORD',
    'RESTIC_PASSWORD',
    'BORG_PASSPHRASE',
  ]
  for (const name of names) {
    it(`redacts a bare ${name}=value`, () => {
      expectRedacted(`${name}=§ ./run.sh`, 'postgres', undefined, 'password-assignment')
    })
  }

  const forms: [string, string][] = [
    ['export PGPASSWORD=§', 'hunter'],
    ["export MYSQL_PWD='§'", 's3cret'],
    ['set PGPASSWORD=§', 'hunter'],
    ['PGPASSWORD="§" psql', 'two words'],
    ['    POSTGRES_PASSWORD: §', 'postgres'],
    ['    POSTGRES_PASSWORD: "§"', 'postgres'],
    ['      - POSTGRES_PASSWORD=§', 'postgres'],
    ['$env:PGPASSWORD = "§"', 'hunter'],
    ['PGPASSWORD=§; psql', 'hunter'],
    ['docker run -e MYSQL_ROOT_PASSWORD=§ mysql', 'root'],
  ]
  for (const [template, secret] of forms) {
    it(`redacts the value in ${template}`, () => {
      expectRedacted(template, secret)
    })
  }

  const negatives = [
    'PGPASSFILE=/home/me/.pgpass',
    'RESTIC_PASSWORD_FILE=/run/secrets/restic',
    'MY_PGPASSWORD_HINT=x',
    'USE_SSHPASS=true',
    'PGPASSWORD=',
    'PGPASSWORD= psql -h db',
    'PGPASSWORD=$DB_PASS psql',
    'PGPASSWORD=${DB_PASS} psql',
    'PGPASSWORD="$(cat /run/secrets/pg)" psql',
    'set PGPASSWORD=%DB_PASS%',
    'POSTGRES_PASSWORD: changeme',
    'POSTGRES_PASSWORD: "<your-password>"',
    'POSTGRES_PASSWORD=***',
    'POSTGRES_PASSWORD=xxxx',
    'POSTGRES_PASSWORD=REDACTED',
    'Set PGPASSWORD in your shell.',
  ]
  for (const code of negatives) {
    it(`leaves ${JSON.stringify(code)} alone`, () => {
      expectNothing(code)
    })
  }
})

describe('URL userinfo', () => {
  const positives: [string, string][] = [
    ['postgres://app:§@db:5432/app', 'postgres'],
    ['redis://:§@cache:6379/0', 'hunter22'],
    ['https://deploy:§@ci.example.com/hook', 'pass1234'],
    ['DATABASE_URL=mysql://root:§@localhost/shop', 'root'],
  ]
  for (const [template, secret] of positives) {
    it(`redacts only the password in ${template}`, () => {
      expectRedacted(template, secret, undefined, 'connection-string')
    })
  }
  // An e-mail address is reported (never redacted) by its own rule, so these
  // check that nothing is redacted and no credential is found.
  const negatives = [
    'ssh deploy@host',
    'git@github.com:org/repo.git',
    'https://deploy@ci.example.com/hook',
    'postgres://app:${DB_PASS}@db/app',
    'postgres://app:changeme@db/app',
    'https://example.com:443/path',
  ]
  for (const code of negatives) {
    it(`leaves ${JSON.stringify(code)} alone`, () => {
      const scan = expectUntouched(code)
      expect(scan.findings.filter((f) => f.type !== 'email')).toEqual([])
    })
  }
})

describe('auth headers', () => {
  const positives: [string, string, SecretType][] = [
    ['curl -H "Authorization: Bearer §" https://api', 'abc12345', 'bearer-token'],
    ['Authorization: Bearer §', 'tok_9x8y7', 'bearer-token'],
    ['authorization: bearer §', 'abcdefgh', 'bearer-token'],
    ['Proxy-Authorization: Bearer §', 'abc12345', 'bearer-token'],
    ["headers: { 'Authorization': 'Bearer §' }", 'abc12345', 'bearer-token'],
    ['Authorization: Basic §', 'dTpwYXNz', 'basic-auth'],
    ['Proxy-Authorization: Basic §', 'dTpw', 'basic-auth'],
    ['curl -H "Authorization: Basic §" https://api', 'YWRtaW46YWRtaW4=', 'basic-auth'],
    ['X-Api-Key: §', 'k3y-1234', 'password-assignment'],
    ['curl -H "X-Api-Key: §" https://api', 'abc1', 'password-assignment'],
    ['x-api-key: §', 'abcdef', 'password-assignment'],
    ['headers = {"X-Api-Key": "§"}', 'abc123', 'password-assignment'],
    ['curl -u admin:§ https://api', 'admin123', 'password-assignment'],
    ['curl --user "admin:§" https://api', 'two words', 'password-assignment'],
    ['curl -s -uadmin:§ https://api', 'hunter22', 'password-assignment'],
  ]
  for (const [template, secret, type] of positives) {
    it(`redacts the value in ${template}`, () => {
      expectRedacted(template, secret, undefined, type)
    })
  }
  const negatives = [
    'Send a Bearer token in the Authorization header.',
    'Authorization: Bearer <token>',
    'Authorization: Bearer ${TOKEN}',
    'Authorization: Bearer token',
    'Authorization: Bearer abc1234',
    'headers: { Authorization: `Bearer ${token}` }',
    "'Authorization': 'Bearer ' + token",
    'Authorization: Basic abc',
    'Authorization: Basic auth is used here',
    'headers = {"X-Api-Key": api_key}',
    "headers['X-Api-Key'] = config.key",
    'X-Api-Key: ${API_KEY}',
    'X-Api-Key: abc',
    'headers = {"X-Api-Key": "v"}',
    'X-Api-Key: <your-api-key>',
    'curl -u admin https://api',
    'curl -u admin: https://api',
    'docker run -u 1000:1000 img',
    'curl -u "$USER:$PASS" https://api',
  ]
  for (const code of negatives) {
    it(`leaves ${JSON.stringify(code)} alone`, () => {
      expectNothing(code)
    })
  }

  it('keeps the 16+ free-standing Bearer rule as it was', () => {
    expectRedacted('token = Bearer §', 'abcdefghijklmnop1234')
  })
})

describe('provider keys in a secret position', () => {
  it('reports a Stripe key after --password as the Stripe key', () => {
    const scan = scanSecrets('tool --password=sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
    expect(scan.findings.map((f) => f.type)).toEqual(['stripe-key'])
    expect(scan.code).toBe('tool --password=__REDACTED_STRIPE_KEY_1__')
  })
})

describe('test, fixture and example paths', () => {
  const testish = [
    'tests/db.test.ts',
    'test/db.ts',
    'src/__tests__/db.ts',
    'src/db.test.ts',
    'src/db.spec.js',
    'spec/models/user_spec.rb',
    'pkg/db/db_test.go',
    'tests/test_db.py',
    'app/test_db.py',
    'conftest.py',
    'fixtures/users.json',
    'src/__fixtures__/a.ts',
    'pkg/testdata/conf.yml',
    'src/__mocks__/db.ts',
    'examples/basic/config.ts',
    'example/app.py',
    'samples/run.sh',
    'e2e/login.ts',
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.test',
    'config/database.yml.example',
    'config/app.sample',
    'config.php.dist',
    'deploy/values.tpl',
    'C:\\repo\\tests\\db.ts',
    'TESTS/DB.TS',
    '/abs/path/to/test/x.ts',
  ]
  for (const path of testish) {
    it(`${path} is a test or example path`, () => {
      expect(isExamplePath(path)).toBe(true)
    })
  }
  const real = [
    'src/config.ts',
    'src/attestation.ts',
    'latest/config.ts',
    'src/contest.py',
    'src/testing-utils.ts',
    '.env',
    '.env.local',
    '.env.production',
    'docker-compose.yml',
    'src/examples.ts',
    'Makefile',
    '',
  ]
  for (const path of real) {
    it(`${JSON.stringify(path)} is real source`, () => {
      expect(isExamplePath(path)).toBe(false)
    })
  }
})

describe('redaction by context (decision 6)', () => {
  // One weak and one strong value per rule. Weak: redacted in real source and
  // with no path, reported in tests and examples. Strong: redacted everywhere.
  const STRONG = 'Xk9#mQ2vL7pZ'
  const STRONG_B64 = 'YWRtaW46WGs5I21RMnZMN3Ba' // admin:Xk9#mQ2vL7pZ
  const rules: { name: string; template: string; weak: string; strong: string }[] = [
    { name: 'mysql -p', template: 'mysql -u root -p§ shop', weak: 'hunter22', strong: STRONG },
    { name: '-P tool', template: 'sqlcmd -U sa -P §', weak: 'Passw0rd', strong: STRONG },
    { name: 'redis-cli -a', template: 'redis-cli -a § ping', weak: 'redis', strong: STRONG },
    { name: '--password', template: 'tool --password=§', weak: 'hunter22', strong: STRONG },
    { name: 'env', template: 'PGPASSWORD=§ psql', weak: 'postgres', strong: STRONG },
    { name: 'userinfo', template: 'postgres://app:§@db/app', weak: 'postgres', strong: STRONG },
    {
      name: 'header Bearer',
      template: 'Authorization: Bearer §',
      weak: 'abc12345',
      strong: 'a3f9c2e1b7d04f6e9a8b7c6d',
    },
    {
      name: 'free Bearer',
      template: 'auth = Bearer §',
      weak: 'testtokentesttoken',
      strong: 'a3f9c2e1b7d04f6e9a8b7c6d',
    },
    {
      name: 'header Basic',
      template: 'Authorization: Basic §',
      weak: 'dTpwYXNz', // u:pass
      strong: STRONG_B64,
    },
    { name: 'X-Api-Key', template: 'X-Api-Key: §', weak: 'test-key', strong: STRONG },
    { name: 'curl -u', template: 'curl -u admin:§ https://api', weak: 'admin', strong: STRONG },
  ]
  const exampleish = ['tests/x.test.ts', '.env.example', 'fixtures/db.yml']
  for (const r of rules) {
    it(`${r.name}: a weak value is redacted in src/config.ts and with no path`, () => {
      expectRedacted(r.template, r.weak, 'src/config.ts')
      expectRedacted(r.template, r.weak)
    })
    for (const path of exampleish) {
      it(`${r.name}: a weak value is only reported in ${path}`, () => {
        expectReportedOnly(r.template.replace('§', r.weak), path)
      })
      it(`${r.name}: a strong value is redacted in ${path}`, () => {
        expectRedacted(r.template, r.strong, path)
      })
    }
    it(`${r.name}: a placeholder is neither redacted nor reported, anywhere`, () => {
      for (const path of [undefined, 'src/config.ts', 'tests/x.test.ts']) {
        expectNothing(r.template.replace('§', '${SECRET}'), path)
      }
    })
  }

  it('a 16-character single-class value counts as weak', () => {
    expectReportedOnly('PGPASSWORD=mysecretpassword psql', 'tests/x.test.ts')
  })

  it('a 12-character mixed value with low entropy counts as weak', () => {
    // Three classes and 12 characters, but entropy 1.6: below the 3.0 floor.
    expectReportedOnly('PGPASSWORD=Aaaa1111aaa! psql', 'tests/x.test.ts')
  })

  it('an 11-character mixed value counts as weak', () => {
    expectReportedOnly('PGPASSWORD=Xk9#mQ2vL7p psql', 'tests/x.test.ts')
  })

  it('a 12-character mixed value counts as strong', () => {
    expectRedacted('PGPASSWORD=§ psql', 'Xk9#mQ2vL7pZ', 'tests/x.test.ts')
  })

  it('a 20+ near-uniform token counts as strong, a 16-character one does not', () => {
    expectRedacted('PGPASSWORD=§ psql', '9f86d081884c7d659a2feaa0c55ad015', 'tests/x.test.ts')
    expectReportedOnly('PGPASSWORD=9f86d081884c7d65 psql', 'tests/x.test.ts')
  })

  it('a long passphrase counts as strong', () => {
    expectRedacted('PGPASSWORD=§ psql', 'correcthorsebatterystaple', 'tests/x.test.ts')
  })

  it('Basic is judged on the decoded password, not the base64', () => {
    // admin:hunter22 encodes to 20 base64 characters of high entropy.
    expectReportedOnly('Authorization: Basic YWRtaW46aHVudGVyMjI=', 'tests/x.test.ts')
  })

  it('leaves the generic password assignment as it was in tests', () => {
    // Out of scope (research R8): a mixed-case value after password = is
    // destroyed in a test file exactly as before.
    expectRedacted('password = "§"', 'Secret123', 'tests/x.test.ts', 'password-assignment')
  })

  it('a downgraded password in userinfo is reported as a credential, not as an e-mail', () => {
    const scan = expectUntouched(
      'postgresql://admin:mypassword@db.internal.io/prod',
      'tests/x.test.ts'
    )
    expect(scan.findings.map((f) => f.type)).toEqual(['possible-credential'])
  })

  it('detectSecrets takes the path too', () => {
    const findings = detectSecrets('PGPASSWORD=postgres psql', { path: 'tests/x.test.ts' })
    expect(findings.map((f) => f.type)).toEqual(['possible-credential'])
    expect(detectSecrets('PGPASSWORD=postgres psql').map((f) => f.type)).toEqual([
      'password-assignment',
    ])
  })

  it('anonymize takes the path and keeps a test fixture intact', () => {
    // Kept means not destroyed: the masking pass may still mask the word
    // reversibly, and restore() must bring the fixture back whole.
    const code = 'const url = "postgres://app:postgres@db/app"\n'
    const inTest = anonymize(code, { path: 'tests/db.test.ts' })
    expect(inTest.anonymized).not.toMatch(TOKEN)
    expect(restore(inTest.anonymized, inTest.map).restored).toBe(code)
    expect(inTest.secrets.map((s) => s.type)).toEqual(['possible-credential'])
    for (const options of [{ path: 'src/db.ts' }, {}]) {
      const inSrc = anonymize(code, options)
      expect(inSrc.anonymized).toMatch(TOKEN)
      expect(restore(inSrc.anonymized, inSrc.map).restored).not.toContain(':postgres@')
    }
  })

  it('anonymize recognises { path } alone as options, not a symbol map', () => {
    const code = 'PGPASSWORD=postgres\n'
    expect(anonymize(code, { path: 'tests/x.test.ts' }).anonymized).not.toMatch(TOKEN)
    expect(anonymize(code, { path: 'src/x.ts' }).anonymized).toMatch(TOKEN)
  })
})

describe('placeholders in any position', () => {
  const placeholders = [
    'changeme',
    'password',
    'xxx',
    'XXXXXXXX',
    'xxxx-xxxx-xxxx',
    '***',
    '********',
    '<your-password>',
    '${DB_PASS}',
    '$DB_PASS',
    '%DB_PASS%',
    '$(cat /run/secrets/pw)',
    'REDACTED',
    '[REDACTED]',
    'redacted',
  ]
  for (const p of placeholders) {
    it(`${p} is a placeholder after --password=`, () => {
      expectNothing(`tool --password=${p.includes(' ') ? `"${p}"` : p}`)
    })
    it(`${p} is a placeholder in a URL`, () => {
      if (/[/:@\s]/.test(p)) return // cannot sit in userinfo unencoded
      expectNothing(`postgres://app:${p}@db/app`)
    })
  }
  it('an empty value is a placeholder', () => {
    expectNothing("mysql -u root -p'' shop")
    expectNothing('tool --password= next')
  })
})

describe('linear time', () => {
  it('a long hostile line scans quickly', () => {
    const lines = [
      'mysql ' + '-p '.repeat(20000),
      'curl ' + '-u a'.repeat(20000),
      'Authorization: '.repeat(20000),
      'PGPASSWORD='.repeat(20000),
      'X-Api-Key:'.repeat(20000),
      'a://' + ':'.repeat(20000),
    ]
    for (const line of lines) {
      const t = performance.now()
      scanSecrets(line)
      expect(performance.now() - t, line.slice(0, 20)).toBeLessThan(1500)
    }
  })
})
