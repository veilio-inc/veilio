import { describe, it, expect } from 'vitest'
import { anonymize } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import { LOGINS, LOGINS_PINNED, PLACES, PW, TOKEN } from './fixtures/baseline-corpus.js'
import { expectKept, expectRedacted, holds } from './fixtures/credential-checks.js'

// A password on a login command line is redacted: the position each command's
// own manual gives it (the registry logins' and az's -p, smbclient's
// user%password, vault login's token, htpasswd -b's last word), and the value
// after any scheme word of an Authorization header. The same flag on another
// command is a port or a path and is read as before.

const SHELL: AnonymizeOptions = { fileKind: 'shell' }
const TS: AnonymizeOptions = { language: 'typescript' }

/** What the redaction takes with the value, as 1.19.2 does: a header's scheme
 *  word, and the flags after a command whose name holds a credential word. */
const also = (line: string): string[] => [
  ...(/Authorization: (\w+) /.exec(line)?.slice(1) ?? []),
  ...(/^htpasswd (-\w{3,})/.exec(line)?.slice(1) ?? []),
]

describe.each(LOGINS)('$name', ({ name, line, secret }) => {
  it.each(PLACES)('is redacted in $place', ({ options, wrap }) => {
    if (!name.endsWith('attached')) {
      expectRedacted(wrap(line), options, [secret], also(line))
      return
    }
    // A token glued to its flag is one word to the masking pass, as after
    // mysql's -p: the password is gone from the output and the map.
    const { anonymized, map } = anonymize(wrap(line), options)
    expect(holds(anonymized, secret)).toBe(false)
    expect(holds(Object.values(map).join('\n'), secret)).toBe(false)
  })
})

describe('forms 1.19.2 redacts already', () => {
  it.each(LOGINS_PINNED)('$name', ({ line, secret }) => {
    for (const { options, wrap } of PLACES)
      expectRedacted(wrap(line), options, [secret], also(line))
  })
})

describe('the password in other spellings of the command', () => {
  it.each<[string, string, string]>([
    ['a line continuation', `docker login -u a \\\n  -p ${PW} reg.example\n`, PW],
    ['single quotes', `docker login -u a -p '${PW}' reg.example\n`, PW],
    ['a global option first', `docker --config /tmp/c login -u a -p ${PW}\n`, PW],
    ['an argument list', `run(["docker", "login", "-u", "a", "-p", "${PW}"])\n`, PW],
    ['the long user option of smbclient', `smbclient //h/s --user=u%${PW}\n`, PW],
    ['smbclient, quoted', `smbclient //h/s -U "u%${PW}"\n`, PW],
    ['vault login after its options', `vault login -no-print -format=json ${TOKEN}\n`, TOKEN],
    ['htpasswd with a cost', `htpasswd -b -C 12 /etc/acme/users deploy ${PW}\n`, PW],
    ['htpasswd before another command', `htpasswd -b f u ${PW} && reload\n`, PW],
  ])('%s', (_, code, secret) => {
    expectRedacted(code, SHELL, [secret])
  })

  it('keeps the flag, the user and the host', () => {
    const { anonymized } = expectRedacted(`docker login -u a -p ${PW} reg.example\n`, SHELL, [PW])
    expect(anonymized).toMatch(/^docker \S+ -u a -p __REDACTED_CREDENTIAL_1__ \S+\.example\n$/)
  })
})

describe('a password piped to a login that reads standard input', () => {
  it.each<[string, string]>([
    ['echo', `echo ${PW} | docker login -u a --password-stdin reg.example\n`],
    ['echo, quoted', `echo "${PW}" | docker login -u a --password-stdin reg.example\n`],
    ['echo -n', `echo -n ${PW} | podman login -u a --password-stdin reg.example\n`],
    ['printf', `printf '%s' '${PW}' | helm registry login reg.example -u a --password-stdin\n`],
  ])('%s', (_, code) => {
    const { anonymized, map } = anonymize(code, SHELL)
    expect(holds(anonymized, PW)).toBe(false)
    expect(holds(Object.values(map).join('\n'), PW)).toBe(false)
  })

  it('a variable, and an echo into another program, are read as before', () => {
    const kept = anonymize('echo "$REGISTRY_PW" | docker login -u a --password-stdin\n', SHELL)
    expect(kept.anonymized).not.toMatch(/echo "?__REDACTED/)
    const other = anonymize(`echo ${PW} | sort\n`, SHELL)
    expect(Object.values(other.map)).toContain(PW)
  })
})

describe('an Authorization header with any scheme word', () => {
  it.each<[string, string, AnonymizeOptions, string[]]>([
    [
      'an unknown scheme',
      `curl -H "Authorization: Custom ${TOKEN}" https://x.example\n`,
      SHELL,
      ['Custom'],
    ],
    ['a raw header line', `Authorization: token ${TOKEN}\n`, { fileKind: 'text' }, ['token ']],
    ['a header map in code', `const h = { Authorization: "ApiKey ${TOKEN}" }\n`, TS, ['ApiKey ']],
    [
      'a quoted header name in code',
      `const h = { "Authorization": "token ${TOKEN}" }\n`,
      TS,
      ['token '],
    ],
    [
      'a header set by a call',
      `req.setHeader("Proxy-Authorization", "token ${TOKEN}")\n`,
      TS,
      ['token '],
    ],
  ])('%s', (_, code, options, also) => {
    expectRedacted(code, options, [TOKEN], also)
  })

  it('a variable after the scheme word is kept', () => {
    const code = 'curl -H "Authorization: token $GH_TOKEN" https://x.example\n'
    expect(anonymize(code, SHELL).anonymized).not.toContain('__REDACTED_BEARER_TOKEN')
  })
})

describe('the same flag where it is no password is read as before', () => {
  it.each([
    'docker run -p 8080:80 -d nginx',
    'docker run --name login -p 8080:80 nginx',
    'ssh -p 2222 deploy@host.example',
    'psql -h db -p 5432 -U app shop',
    'smbclient //h/s -U deploy',
    'htpasswd -c /etc/acme/users deploy',
  ])('%s', (line) => {
    for (const { options, wrap } of PLACES) expectKept(wrap(line), options)
  })

  // Words of a sentence, a variable and another login method are no
  // password: the word in the password's position is left as it was.
  it.each<[string, string, RegExp]>([
    ['a variable', 'docker login -u a -p "$REGISTRY_PW" reg.example\n', /-p "?__REDACTED/],
    [
      'a sentence about the flag',
      'docker login -p is unsafe: use --password-stdin\n',
      /-p __REDACTED/,
    ],
    [
      'a sentence about vault login',
      'vault login with the token of your team\n',
      /login __REDACTED/,
    ],
    ['another login method', 'vault login -method=userpass username=deploy\n', /login __REDACTED/],
    [
      'a sentence about htpasswd',
      'htpasswd -b takes a new entry from its arguments\n',
      /__REDACTED/,
    ],
    [
      'a sentence about the header',
      'Authorization: Token authentication is required\n',
      /__REDACTED_BEARER/,
    ],
  ])('%s', (_, code, never) => {
    for (const options of [SHELL, { fileKind: 'text' }] as AnonymizeOptions[])
      expect(anonymize(code, options).anonymized).not.toMatch(never)
  })

  it('a here-string is free text: its password is masked, not redacted', () => {
    const { anonymized, map } = anonymize(`ftp -n h <<< "user u ${PW}"\n`, SHELL)
    expect(holds(anonymized, PW)).toBe(false)
    expect(Object.values(map)).toContain(PW)
  })
})
