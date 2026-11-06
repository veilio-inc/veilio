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

test('a run whose masking would change its line count is left to the per-line masking', async ($, on) => {
  const grep = recorded('Grep')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    [`${ROOT}/conf/s.xml`]: 'x\n',
    [`${ROOT}/deploy/k8s.yaml`]: 'x\n',
  })
  // The engine reads this element's value across the line break; the k8s
  // pair after it is still masked in its own run.
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
  expect(got[1]).toMatch(/^conf\/s\.xml-2-/)
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
  files: string[],
  later: string,
  args: Record<string, unknown> = {}
) {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED),
    ...Object.fromEntries(files.map((f) => [`${ROOT}/${f}`, 'x\n'])),
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

test("a code file's unquoted value is masked in the search and not remembered; a quoted one is", async ($, on) => {
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
