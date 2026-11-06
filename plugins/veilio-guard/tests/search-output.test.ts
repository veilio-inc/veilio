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
