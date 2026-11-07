// Spec 074: search output (the Grep tool, `rg`/`grep` in a shell) is masked
// and remembered as the same text read whole is. Each test fires a recorded
// tool.call through the real hooks, with the result Claude Code would give
// and the files the result names on the project's disk.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT, res } from './helpers.ts'

const SEEDED = { __CLS__1: CANARY, __VAR__1: 'settledTotal', __VAR__2: 'batchEntries' }
const TOKEN = /__REDACTED_CREDENTIAL_\d+__/

type Shape = { label: string; path: string; body: string[]; value: string; at: number }
const SHAPES: Shape[] = [
  {
    label: 'a k8s env entry',
    path: 'deploy/k8s.yaml',
    body: ['  - name: DB_PASSWORD', '    value: qx7mkplzrvnwtyb'],
    value: 'qx7mkplzrvnwtyb',
    at: 1,
  },
  {
    label: 'a YAML value on the next line',
    path: 'config/db.yml',
    body: ['  password:', '    xk9mq2vl7zpqwr'],
    value: 'xk9mq2vl7zpqwr',
    at: 1,
  },
  {
    label: 'a three-line XML element',
    path: 'conf/server.xml',
    body: ['  <password>', '    wb4nr8tlq2xzkm', '  </password>'],
    value: 'wb4nr8tlq2xzkm',
    at: 1,
  },
]
// How each search prints the lines (starting at line 2): the Grep tool's
// default, without -n, and with `path` set to the one file.
const FORMATS = {
  '-n': (s: Shape) => s.body.map((l, j) => `${s.path}${j ? `-${j + 2}-` : `:${j + 2}:`}${l}`),
  'no -n': (s: Shape) => s.body.map((l, j) => `${s.path}${j ? '-' : ':'}${l}`),
  'one file': (s: Shape) => s.body.map((l, j) => `${j + 2}${j ? '-' : ':'}${l}`),
} as const
const argsFor = (format: keyof typeof FORMATS, s: Shape) => ({
  pattern: 'password',
  output_mode: 'content',
  '-A': s.body.length - 1,
  ...(format === 'no -n' ? { '-n': false } : {}),
  ...(format === 'one file' ? { path: s.path } : {}),
})
const fileOf = (s: Shape) => `x: 1\n${s.body.join('\n')}\n`

type Body = Parameters<typeof test>[1]
const splitMasked =
  (s: Shape, format: keyof typeof FORMATS): Body =>
  async ($, on) => {
    const grep = recorded('Grep')
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
      [`${ROOT}/${s.path}`]: fileOf(s),
    })
    const lines = FORMATS[format](s)
    const content = lines.join('\n')
    on('tool.call', () => ({
      ...grep.r,
      result: { ...grep.r.result, content, numLines: lines.length },
    }))
    const out = await $.tool.call({ ...eventOf(grep), ...argsFor(format, s) })
    const got = (res(out).content as string).split('\n')
    expect(JSON.stringify(out)).not.toContain(s.value)
    // The rest of every line reads as before.
    expect(got.length).toBe(lines.length)
    got.forEach((l, i) => {
      if (i === s.at) expect(l).toBe(lines[i]!.replace(s.value, l.match(TOKEN)?.[0] ?? '?'))
      else expect(l).toBe(lines[i])
    })
  }
const readWhole =
  (s: Shape): Body =>
  async ($, on) => {
    const read = recorded('Read')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
    const filePath = `${ROOT}/${s.path}`
    on('tool.call', () => ({
      ...read.r,
      result: { ...read.r.result, file: { ...read.r.result.file, filePath, content: fileOf(s) } },
    }))
    const out = await $.tool.call({ ...eventOf(read), file_path: filePath })
    const content = res(out).file.content as string
    expect(content).not.toContain(s.value)
    expect(content.split('\n')[1 + s.at]).toMatch(TOKEN)
  }
const [K8S, YAML, XML] = SHAPES as [Shape, Shape, Shape]

test('a k8s env entry split across search lines is masked in place', splitMasked(K8S, '-n'))
test(
  'a YAML value on the line after its key is masked in place in a search',
  splitMasked(YAML, '-n')
)
test('a three-line XML element in a search is masked in place', splitMasked(XML, '-n'))
test('a split credential is masked in a search without line numbers', splitMasked(K8S, 'no -n'))
test('a split credential is masked in a search of one file', splitMasked(K8S, 'one file'))
test('a k8s env entry read whole is masked as its search is', readWhole(K8S))
// The whole matrix: every shape in every format, and through Read.
for (const s of SHAPES) {
  for (const format of Object.keys(FORMATS) as (keyof typeof FORMATS)[])
    test(
      `split across search lines, masked in place: ${s.label}, ${format}`,
      splitMasked(s, format)
    )
  test(`read whole, masked the same way: ${s.label}`, readWhole(s))
}

test('files one after another: each value is judged with its own file only', async ($, on) => {
  const grep = recorded('Grep')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/a/k8s.yaml`]: 'x\n',
    [`${ROOT}/b/k8s.yaml`]: 'x\n',
  })
  const content = [
    'a/k8s.yaml:2:  - name: DB_PASSWORD',
    'a/k8s.yaml-3-    value: wb4nr8tlq2xzkm',
    '--',
    'b/k8s.yaml:2:  - name: MODE',
    'b/k8s.yaml-3-    value: pz6vt1yhq8lmnc',
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 5 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-A': 1 })
  const got = res(out).content as string
  expect(got).not.toContain('wb4nr8tlq2xzkm')
  expect(got).toContain('b/k8s.yaml-3-    value: pz6vt1yhq8lmnc')
})

test("a key on one file's line never pairs with the next file's value", async ($, on) => {
  const grep = recorded('Grep')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/a/k8s.yaml`]: 'x\n',
    [`${ROOT}/b/k8s.yaml`]: 'x\n',
  })
  const content = 'a/k8s.yaml:2:  - name: DB_PASSWORD\nb/k8s.yaml-3-    value: pz6vt1yhq8lmnc'
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 2 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-A': 1 })
  expect(res(out).content).toBe(content)
})

test('a value over two lines of a search is masked on both, and the run beside it too', async ($, on) => {
  const grep = recorded('Grep')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/conf/s.xml`]: 'x\n',
    [`${ROOT}/deploy/k8s.yaml`]: 'x\n',
  })
  // The engine reads this element's value across the line break.
  const lines = [
    'conf/s.xml:1:<password>xk9mq2vl7zpqwr',
    'conf/s.xml-2-wb4nr8tlq2xzkm</password>',
    '--',
    'deploy/k8s.yaml:2:  - name: DB_PASSWORD',
    'deploy/k8s.yaml-3-    value: qx7mkplzrvnwtyb',
  ]
  const content = lines.join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 5 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-A': 1 })
  const got = (res(out).content as string).split('\n')
  expect(got.length).toBe(5)
  expect(got[0]).toMatch(/^conf\/s\.xml:1:<password>__REDACTED_CREDENTIAL_\d+__$/)
  expect(got[1]).toMatch(/^conf\/s\.xml-2-__REDACTED_CREDENTIAL_\d+__<\/password>$/)
  expect(got[4]).toMatch(/^deploy\/k8s\.yaml-3- {4}value: __REDACTED_CREDENTIAL_\d+__$/)
})

test('a file the search names that is not on disk: the result is masked as before', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content =
    'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: qx7mkplzrvnwtyb'
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 2 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-A': 1 })
  // Not resolved, so not paired: exactly the per-line masking of main.
  expect(res(out).content).toBe(content)
})

// US2: what a search shows under a key that names a secret is remembered by
// CE #204's rules, so a later bare copy is masked - as after a Read.
/** A Grep result, then a Bash result printing `later`: both outcomes. */
async function searchThen(
  $: Parameters<Body>[0],
  on: Parameters<Body>[1],
  content: string,
  files: string[] | Record<string, string>,
  later: string,
  args: Record<string, unknown> = {}
) {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    // A list: files holding `x`; a record: each file's own text.
    ...Object.fromEntries(
      (Array.isArray(files) ? files.map((f) => [f, 'x\n']) : Object.entries(files)).map(
        ([f, t]) => [`${ROOT}/${f}`, t]
      )
    ),
  })
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? { ...grep.r, result: { ...grep.r.result, content, numLines: content.split('\n').length } }
      : { ...bash.r, result: { ...bash.r.result, stdout: later } }
  )
  const one = await $.tool.call({ ...eventOf(grep), ...args })
  const two = await $.tool.call(eventOf(bash))
  return { one: res(one).content as string, two: res(two).stdout as string }
}

test('a strong credential on a config search line is remembered for a later bare copy', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'config/app.yaml:12:password: xk9mq2vl7zpqwr',
    ['config/app.yaml'],
    'connecting with xk9mq2vl7zpqwr\n'
  )
  expect(r.one).toMatch(/^config\/app\.yaml:12:password: __REDACTED_CREDENTIAL_\d+__$/)
  expect(r.two).toMatch(/^connecting with __REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a split k8s credential in a search is remembered too', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: qx7mkplzrvnwtyb',
    ['deploy/k8s.yaml'],
    'psql with qx7mkplzrvnwtyb\n',
    { '-A': 1 }
  )
  expect(r.two).toMatch(/^psql with __REDACTED_CREDENTIAL_\d+__\n$/)
})

test("a code file's unquoted value is masked in the search and not remembered, a quoted one is", async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'src/app.py:4:    self.secret_key = rotatekeyv2xq9\nsrc/app.py:5:    session_token = "xk9mq2vl7zpqwr"',
    ['src/app.py'],
    'rotatekeyv2xq9 xk9mq2vl7zpqwr\n'
  )
  expect(r.one).not.toContain('rotatekeyv2xq9')
  expect(r.one).not.toContain('xk9mq2vl7zpqwr')
  expect(r.two).toMatch(/^rotatekeyv2xq9 __REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a weak value in a search is masked where it stands and not carried forward (decision #5)', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'config/app.yaml:3:password: sunshine2026',
    ['config/app.yaml'],
    'the sunshine2026 campaign\n'
  )
  expect(r.one).not.toContain('sunshine2026')
  expect(r.two).toBe('the sunshine2026 campaign\n')
})

test('a weak value is not swept from the rest of the search result', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'config/app.yaml:3:password: admin\nREADME.md:9:log in as admin',
    ['config/app.yaml', 'README.md'],
    'admin\n'
  )
  expect(r.one.split('\n')[0]).not.toContain('admin')
  expect(r.one.split('\n')[1]).toBe('README.md:9:log in as admin')
})

test('references, encrypted values and resource names in a search teach nothing', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    [
      'config/app.yaml:1:password: ${DB_PASSWORD}',
      'config/app.yaml:2:api_token: ENC(xq9mk2plzrvnw7ab)',
      'config/app.yaml:3:secret_key: arn:aws:kms:us-east-1:123456789012:key/abcd',
      'config/app.yaml:4:db_password: PROD_DB_PASSWORD_V2',
      'config/app.yaml:5:passwordSecret: argocd-repo-creds-x7k',
      'config/app.yaml:6:api_key: xk9mq2vl7zpqwr',
    ].join('\n'),
    ['config/app.yaml'],
    // Each on a line of its own: `NAME value` would be a key and its value.
    'see ENC(xq9mk2plzrvnw7ab)\nunset PROD_DB_PASSWORD_V2\nargocd-repo-creds-x7k ok\nxk9mq2vl7zpqwr ok\n'
  )
  expect(r.two).toMatch(
    /^see ENC\(xq9mk2plzrvnw7ab\)\nunset PROD_DB_PASSWORD_V2\nargocd-repo-creds-x7k ok\n__REDACTED_CREDENTIAL_\d+__ ok\n$/
  )
})

// US3: a secret mounted as a file holds only its value; the file's name is
// the key (`/run/secrets/db_password`). Main masks such a line by its path;
// pass 2 reads it as `<name>: <value>`, so a one-file search is masked too
// and a strong value is remembered.
test('a secret file named for its key, in a search of many files: masked and remembered', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'secrets/db_password:1:xq9mk2plzrvnw7\nsrc/a.ts:1:x',
    { 'secrets/db_password': 'xq9mk2plzrvnw7\n', 'src/a.ts': 'x\n' },
    'xq9mk2plzrvnw7\n'
  )
  expect(r.one).not.toContain('xq9mk2plzrvnw7')
  // Main's per-line masking reads `db_password` as the key here, as before.
  expect(r.one).toMatch(/^secrets\/__VAR__\d+:__REDACTED_CREDENTIAL_\d+__\nsrc\/a\.ts:1:x$/)
  expect(r.two).toMatch(/^__REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a secret file named for its key, without line numbers', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'secrets/api_token.txt:xq9mk2plzrvnw7\nsrc/a.ts:x',
    { 'secrets/api_token.txt': 'xq9mk2plzrvnw7\n', 'src/a.ts': 'x\n' },
    'xq9mk2plzrvnw7\n',
    { '-n': false }
  )
  expect(r.one).not.toContain('xq9mk2plzrvnw7')
  expect(r.two).toMatch(/^__REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a secret file named for its key, searched alone: no path on the line, still masked', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:xq9mk2plzrvnw7',
    { 'secrets/db_password': 'xq9mk2plzrvnw7\n' },
    'xq9mk2plzrvnw7\n',
    { path: 'secrets/db_password' }
  )
  expect(r.one).toMatch(/^1:__REDACTED_CREDENTIAL_\d+__$/)
  expect(r.two).toMatch(/^__REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a mounted secret under an absolute path is read the same way', async ($, on) => {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    '/run/secrets/api_token': 'xq9mk2plzrvnw7\n',
  })
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? {
          ...grep.r,
          result: {
            ...grep.r.result,
            content: '/run/secrets/api_token:1:xq9mk2plzrvnw7',
            numLines: 1,
          },
        }
      : { ...bash.r, result: { ...bash.r.result, stdout: 'xq9mk2plzrvnw7\n' } }
  )
  const one = await $.tool.call(eventOf(grep))
  expect(JSON.stringify(one)).not.toContain('xq9mk2plzrvnw7')
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).toMatch(/^__REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a weak value in a file named for its key is masked and not remembered', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:sunshine2026',
    { 'secrets/db_password': 'sunshine2026\n' },
    'the sunshine2026 campaign\n',
    { path: 'secrets/db_password' }
  )
  expect(r.one).toMatch(/^1:__REDACTED_CREDENTIAL_\d+__$/)
  expect(r.two).toBe('the sunshine2026 campaign\n')
})

test("a configuration file under secrets/ keeps its own grammar, not its name's", async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:host: db.internal.example\n2:password: xq9mk2plzrvnw7',
    ['secrets/db.yaml'],
    'xq9mk2plzrvnw7 db.internal.example\n',
    { path: 'secrets/db.yaml' }
  )
  expect(r.one).toMatch(/^1:host: db\.internal\.example\n2:password: __REDACTED_CREDENTIAL_\d+__$/)
  expect(r.two).toMatch(/^__REDACTED_CREDENTIAL_\d+__ db\.internal\.example\n$/)
})

test('a file whose name names no secret is not read as a key', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:Use twelve characters or more',
    ['docs/password_policy.txt'],
    'x\n',
    { path: 'docs/password_policy.txt' }
  )
  expect(r.one).toBe('1:Use twelve characters or more')
})

// US4: the same search through a shell. A command is read as search output
// only when it is one plain `rg` or `grep` (optionally into `head`/`tail`);
// anything else is masked exactly as before, so the same stdout under any
// other command keeps the split pair as main shows it.
const PAIR_N =
  'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: qx7mkplzrvnwtyb\n'
const PAIR_PLAIN =
  'deploy/k8s.yaml:  - name: DB_PASSWORD\ndeploy/k8s.yaml-    value: qx7mkplzrvnwtyb\n'
const PAIR_ONE = '2:  - name: DB_PASSWORD\n3-    value: qx7mkplzrvnwtyb\n'

async function shell(
  $: Parameters<Body>[0],
  on: Parameters<Body>[1],
  command: string,
  stdout: string
) {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/deploy/k8s.yaml`]: 'x\n',
    [`${ROOT}/secrets/db_password`]: 'xq9mk2plzrvnw7\n',
  })
  let call = 0
  on('tool.call', () => ({
    ...bash.r,
    result: {
      ...bash.r.result,
      stdout: call++ === 0 ? stdout : 'later qx7mkplzrvnwtyb xq9mk2plzrvnw7\n',
    },
  }))
  const one = await $.tool.call({ ...eventOf(bash), command })
  const two = await $.tool.call(eventOf(bash))
  return { one: res(one).stdout as string, two: res(two).stdout as string }
}
const MASKED_PAIR =
  /^deploy\/k8s\.yaml:2: {2}- name: DB_PASSWORD\ndeploy\/k8s\.yaml-3- {4}value: __REDACTED_CREDENTIAL_\d+__\n$/

test('rg -n output: a split credential is masked and remembered, as in the Grep tool', async ($, on) => {
  const r = await shell($, on, 'rg -n -A1 DB_PASSWORD deploy', PAIR_N)
  expect(r.one).toMatch(MASKED_PAIR)
  expect(r.two).toMatch(/^later __REDACTED_CREDENTIAL_\d+__ xq9mk2plzrvnw7\n$/)
})

test('rg piped prints no line numbers: read without them', async ($, on) => {
  const r = await shell($, on, "rg -A1 'DB_PASSWORD' deploy", PAIR_PLAIN)
  expect(r.one).not.toContain('qx7mkplzrvnwtyb')
  expect(r.one).toMatch(/^deploy\/k8s\.yaml: {2}- name: DB_PASSWORD\n/)
})

test('grep -rn output, into head: masked as the Grep tool', async ($, on) => {
  const r = await shell($, on, 'grep -rn -A 1 DB_PASSWORD deploy | head -n 20', PAIR_N)
  expect(r.one).toMatch(MASKED_PAIR)
})

test('grep -n on one file: no path on the line, still masked', async ($, on) => {
  const r = await shell($, on, 'grep -n -A1 DB_PASSWORD deploy/k8s.yaml', PAIR_ONE)
  expect(r.one).toMatch(/^2: {2}- name: DB_PASSWORD\n3- {4}value: __REDACTED_CREDENTIAL_\d+__\n$/)
})

// Captured on macOS 2026-11-07 (Claude Code's shell grep, ugrep 7.8.4, and
// BSD grep 2.6.0 print the same): `grep -rn` names even one file.
test('grep -rn on one file prints its path: masked as the Grep tool', async ($, on) => {
  const r = await shell($, on, 'grep -rn -A1 DB_PASSWORD deploy/k8s.yaml', PAIR_N)
  expect(r.one).toMatch(MASKED_PAIR)
})

test('rg over a secret file named for its key: masked and remembered', async ($, on) => {
  const r = await shell($, on, 'rg x secrets/db_password', 'xq9mk2plzrvnw7\n')
  expect(r.one).toMatch(/^__REDACTED_CREDENTIAL_\d+__\n$/)
  expect(r.two).toMatch(/^later qx7mkplzrvnwtyb __REDACTED_CREDENTIAL_\d+__\n$/)
})

const NOT_SEARCH = [
  'rg -n -A1 DB_PASSWORD deploy | sort',
  'cd deploy && rg -n -A1 DB_PASSWORD .',
  'rg -n -A1 DB_PASSWORD deploy; echo done',
  'rg --json DB_PASSWORD deploy',
  'rg --heading -n -A1 DB_PASSWORD deploy',
  'rg -l DB_PASSWORD',
  'rg -c DB_PASSWORD',
  'rg -o -n DB_PASSWORD deploy',
  'rg -n -A1 "$PATTERN" deploy',
  'cat deploy/k8s.yaml',
  'tail -n 2 app.log',
  'FOO=1 rg -n -A1 DB_PASSWORD deploy',
]
test('shell output that is not one plain search is masked exactly as before', async ($, on) => {
  const r = await shell($, on, 'rg -n -A1 DB_PASSWORD deploy | sort', PAIR_N)
  expect(r.one).toBe(PAIR_N)
})
for (const command of NOT_SEARCH)
  test(`not one plain search, masked as before: ${command}`, async ($, on) => {
    const r = await shell($, on, command, PAIR_N)
    expect(r.one).toBe(PAIR_N)
  })

// T024 review: the file-named key is for a mounted secret only - a file with
// no extension (or .txt, .secret) that is not code and holds one value, the
// value the search shows. Code and documents named for a secret are not.
for (const [path, line] of [
  ['src/useAuthToken.ts', 'export function useAuthToken() {'],
  ['src/access_token.ts', '// refresh before it expires'],
  ['app/secret_key.py', 'import os'],
  ['docs/password.md', 'Choose a strong passphrase'],
  ['docs/api_token.txt', 'Ask the platform team for one'],
] as const)
  test(`a file named for a secret that is not a mounted value keeps its line: ${path}`, async ($, on) => {
    const r = await searchThen($, on, `1:${line}`, { [path]: `${line}\nmore text\n` }, 'x\n', {
      path,
    })
    expect(r.one).not.toContain('__REDACTED_')
  })
test('a file named for a secret that holds more than its value is not read as a key', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:xq9mk2plzrvnw7',
    { 'secrets/db_password': 'xq9mk2plzrvnw7\nrotated 2026-11-01\n' },
    'xq9mk2plzrvnw7\n',
    { path: 'secrets/db_password' }
  )
  expect(r.one).toBe('1:xq9mk2plzrvnw7')
})
test('a code file named for a secret keeps its lines in a search', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:export function useAuthToken() {',
    { 'src/useAuthToken.ts': 'export function useAuthToken() {\n' },
    'x\n',
    { path: 'src/useAuthToken.ts' }
  )
  expect(r.one).not.toContain('__REDACTED_')
})
test('a file named for a secret larger than 4 KB is not read as one value', async ($, on) => {
  const big = 'xq9mk2plzrvnw7'.repeat(300)
  const r = await searchThen($, on, `1:${big}`, { 'secrets/db_password': `${big}\n` }, 'x\n', {
    path: 'secrets/db_password',
  })
  expect(r.one).toBe(`1:${big}`)
})
// Each rule alone (mutation checks): the extension, whitespace, the file's
// own text.
test('a document named for a secret is not read as a key, even holding one word', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:xq9mk2plzrvnw7',
    { 'docs/password.md': 'xq9mk2plzrvnw7\n' },
    'x\n',
    {
      path: 'docs/password.md',
    }
  )
  expect(r.one).toBe('1:xq9mk2plzrvnw7')
})
test('a file named for a secret holding words is not read as one value', async ($, on) => {
  const r = await searchThen($, on, '1:ask ops', { 'secrets/db_password': 'ask ops\n' }, 'x\n', {
    path: 'secrets/db_password',
  })
  expect(r.one).toBe('1:ask ops')
})
test('a file named for a secret is read as one only with the value on disk it shows', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:zz9mk2plzrvnw7',
    { 'secrets/db_password': 'xq9mk2plzrvnw7\n' },
    'x\n',
    {
      path: 'secrets/db_password',
    }
  )
  expect(r.one).toBe('1:zz9mk2plzrvnw7')
})
test('a file named for a secret whose one word is a key and value is read by its own grammar', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:user=admin',
    { 'secrets/db_password': 'user=admin\n' },
    'x\n',
    {
      path: 'secrets/db_password',
    }
  )
  expect(r.one).toBe('1:user=admin')
})

// Security review of a5ca329: a file the guard cannot read affects its own
// run only; a BOM and trailing whitespace are not part of the value; a file
// it cannot confirm is masked as main masks it, by its path.
test('a secret file that cannot be read leaves the rest of the search to pass 2', async ($, on) => {
  const grep = recorded('Grep')
  project(
    on,
    {
      [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
      [`${ROOT}/secrets/db_password`]: 'xq9mk2plzrvnw7\n',
      [`${ROOT}/deploy/k8s.yaml`]: 'x\n',
    },
    { failRead: (p) => p.endsWith('/secrets/db_password') }
  )
  const content =
    'secrets/db_password:1:xq9mk2plzrvnw7\n--\ndeploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: qx7mkplzrvnwtyb'
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 4 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-A': 1 })
  const got = res(out).content as string
  expect(got).not.toContain('qx7mkplzrvnwtyb')
  expect(got).not.toContain('xq9mk2plzrvnw7')
})

test('a secret file with a BOM and trailing blank lines is read as its one value', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    '1:xq9mk2plzrvnw7',
    { 'secrets/db_password': '﻿xq9mk2plzrvnw7 \n\n' },
    'xq9mk2plzrvnw7\n',
    { path: 'secrets/db_password' }
  )
  expect(r.one).toMatch(/^1:__REDACTED_CREDENTIAL_\d+__$/)
})

test('a secret file that is not one value is still masked by its path, as on main', async ($, on) => {
  const r = await searchThen(
    $,
    on,
    'secrets/db_password:1:xq9mk2plzrvnw7',
    { 'secrets/db_password': 'xq9mk2plzrvnw7\nrotated 2026-11-01\n' },
    'x\n'
  )
  // Main reads `db_password` before the line number as the key. (A value with
  // spaces it reads only to the first space: COVERAGE.md, Not covered.)
  expect(r.one).toMatch(/^secrets\/__VAR__\d+:__REDACTED_CREDENTIAL_\d+__$/)
})

test('a long search without line numbers still pairs a credential at its end', async ($, on) => {
  const grep = recorded('Grep')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/config/app.yaml`]: 'x\n',
    [`${ROOT}/deploy/k8s.yaml`]: 'x\n',
  })
  const config = Array.from({ length: 300 }, (_, i) => `config/app.yaml:  key${i}: v:${i}: w`)
  const content = [
    ...config,
    '--',
    'deploy/k8s.yaml:  - name: DB_PASSWORD',
    'deploy/k8s.yaml-    value: qx7mkplzrvnwtyb',
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 303 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-n': false, '-A': 1 })
  expect(res(out).content).not.toContain('qx7mkplzrvnwtyb')
})

// T024 review: Claude Code's shell keeps an earlier `cd`, so a shell search's
// relative paths may be another directory's. Once any command has moved it,
// shell output is masked as before for the rest of the session.
test('after a cd in the shell, a shell search is masked as before', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/k8s.yaml`]: 'x\n',
    [`${ROOT}/deploy/k8s.yaml`]: 'x\n',
  })
  const pair = 'k8s.yaml:2:  - name: DB_PASSWORD\nk8s.yaml-3-    value: qx7mkplzrvnwtyb\n'
  let call = 0
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, stdout: call++ === 0 ? '' : pair },
  }))
  await $.tool.call({ ...eventOf(bash), command: 'cd deploy' })
  const out = await $.tool.call({ ...eventOf(bash), command: 'rg -n -A1 DB_PASSWORD .' })
  expect(res(out).stdout).toBe(pair)
})
test('a cd after && moves the shell too', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/k8s.yaml`]: 'x\n',
  })
  const pair = 'k8s.yaml:2:  - name: DB_PASSWORD\nk8s.yaml-3-    value: qx7mkplzrvnwtyb\n'
  let call = 0
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, stdout: call++ === 0 ? '' : pair },
  }))
  await $.tool.call({ ...eventOf(bash), command: 'npm ci && pushd deploy' })
  const out = await $.tool.call({ ...eventOf(bash), command: 'rg -n -A1 DB_PASSWORD .' })
  expect(res(out).stdout).toBe(pair)
})
test('a shell that has not moved still reads a search by file', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED), [`${ROOT}/k8s.yaml`]: 'x\n' })
  const pair = 'k8s.yaml:2:  - name: DB_PASSWORD\nk8s.yaml-3-    value: qx7mkplzrvnwtyb\n'
  let call = 0
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, stdout: call++ === 0 ? '' : pair },
  }))
  await $.tool.call({ ...eventOf(bash), command: 'echo cd is a word here' })
  const out = await $.tool.call({ ...eventOf(bash), command: 'rg -n -A1 DB_PASSWORD .' })
  expect(res(out).stdout).not.toContain('qx7mkplzrvnwtyb')
})
test('a cd in a command that then fails moves the shell too', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED), [`${ROOT}/k8s.yaml`]: 'x\n' })
  const pair = 'k8s.yaml:2:  - name: DB_PASSWORD\nk8s.yaml-3-    value: qx7mkplzrvnwtyb\n'
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? { result: 'Error: Exit code 1', text: 'Exit code 1', isError: true }
      : { ...bash.r, result: { ...bash.r.result, stdout: pair } }
  )
  await $.tool.call({ ...eventOf(bash), command: 'cd deploy && false' })
  const out = await $.tool.call({ ...eventOf(bash), command: 'rg -n -A1 DB_PASSWORD .' })
  expect(res(out).stdout).toBe(pair)
})

// T024 review: links are followed. A k8s secret mount is a link into
// `..data/`; a link to a folder is no file to read a line by.
test('a mounted secret behind a symbolic link is read as its key', async ($, on) => {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(
    on,
    {
      [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
      [`${ROOT}/run/secrets/..data/db_password`]: 'xq9mk2plzrvnw7\n',
    },
    { links: { [`${ROOT}/run/secrets/db_password`]: `${ROOT}/run/secrets/..data/db_password` } }
  )
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? { ...grep.r, result: { ...grep.r.result, content: '1:xq9mk2plzrvnw7', numLines: 1 } }
      : { ...bash.r, result: { ...bash.r.result, stdout: 'xq9mk2plzrvnw7\n' } }
  )
  const one = await $.tool.call({ ...eventOf(grep), path: 'run/secrets/db_password' })
  expect(res(one).content).toMatch(/^1:__REDACTED_CREDENTIAL_\d+__$/)
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).toMatch(/^__REDACTED_CREDENTIAL_\d+__\n$/)
})
test('a symbolic link to a folder is no file: its lines are masked as before', async ($, on) => {
  const grep = recorded('Grep')
  project(
    on,
    { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED), [`${ROOT}/real-conf/a.yaml`]: 'x\n' },
    { links: { [`${ROOT}/conf`]: `${ROOT}/real-conf` } }
  )
  const content = 'conf:2:  - name: DB_PASSWORD\nconf-3-    value: qx7mkplzrvnwtyb'
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 2 } }))
  const out = await $.tool.call({ ...eventOf(grep), '-A': 1 })
  expect(res(out).content).toBe(content)
})
