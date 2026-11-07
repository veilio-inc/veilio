import { describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
import {
  parseSearchOutput,
  searchCommand,
  searchPath,
  SEARCH_LIMITS,
  type SearchFormat,
} from '../../plugins/veilio-guard/lib/search.ts'

// Spec 074 research R1-R3, R6: search output is cut into its files' lines only
// where the files on disk say so - never by a pattern alone (e72's removed
// split cut .pgpass lines and dated paths at the wrong `:NN:`).
const BASE = '/p'
function disk(...files: string[]) {
  const set = new Set(files.map((f) => (f.startsWith('/') ? f : `${BASE}/${f}`)))
  const asked: string[] = []
  return {
    asked,
    fileExists: async (path: string) => {
      asked.push(path)
      return set.has(path)
    },
  }
}
const parse = (text: string, format: Partial<SearchFormat>, d = disk()) =>
  parseSearchOutput(text, { numbered: true, context: false, base: BASE, ...format, ...d })

describe('parseSearchOutput: the formats of research R1', () => {
  it('many files, numbered: match, context and --', async () => {
    const d = disk('deploy/k8s.yaml', 'a.yaml')
    const r = await parse(
      'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: X\n--\na.yaml:9:k: v',
      { context: true },
      d
    )
    expect(r.lines.map((l) => [l.kind, l.path, l.lineNumber, l.body])).toEqual([
      ['match', 'deploy/k8s.yaml', 2, '  - name: DB_PASSWORD'],
      ['context', 'deploy/k8s.yaml', 3, '    value: X'],
      ['separator', undefined, undefined, undefined],
      ['match', 'a.yaml', 9, 'k: v'],
    ])
    expect(r.runs).toEqual([
      { path: 'deploy/k8s.yaml', lines: [0, 1] },
      { path: 'a.yaml', lines: [3] },
    ])
  })

  it('many files, no numbers: path:text and path-text', async () => {
    const d = disk('deploy/k8s.yaml')
    const r = await parse(
      'deploy/k8s.yaml:  - name: DB_PASSWORD\ndeploy/k8s.yaml-    value: X',
      { numbered: false, context: true },
      d
    )
    expect(r.lines.map((l) => [l.kind, l.path, l.body])).toEqual([
      ['match', 'deploy/k8s.yaml', '  - name: DB_PASSWORD'],
      ['context', 'deploy/k8s.yaml', '    value: X'],
    ])
    expect(r.runs).toEqual([{ path: 'deploy/k8s.yaml', lines: [0, 1] }])
  })

  it('no numbers and no context: each line is its own run (matches need not be adjacent)', async () => {
    const r = await parse(
      'a.yaml:password:\na.yaml:  other: x',
      { numbered: false },
      disk('a.yaml')
    )
    expect(r.runs).toEqual([
      { path: 'a.yaml', lines: [0] },
      { path: 'a.yaml', lines: [1] },
    ])
  })

  it('a context line is read only when context is on', async () => {
    const r = await parse('deploy/k8s.yaml-3-    value: X', {}, disk('deploy/k8s.yaml'))
    expect(r.lines[0]!.kind).toBe('unresolved')
  })

  it('one file, numbered: N:text and N-text, no path', async () => {
    const d = disk('deploy/k8s.yaml')
    const r = await parse(
      '2:  - name: DB_PASSWORD\n3-    value: X',
      { oneFile: 'deploy/k8s.yaml', context: true },
      d
    )
    expect(r.lines.map((l) => [l.kind, l.path, l.lineNumber, l.body])).toEqual([
      ['match', 'deploy/k8s.yaml', 2, '  - name: DB_PASSWORD'],
      ['context', 'deploy/k8s.yaml', 3, '    value: X'],
    ])
    expect(r.runs).toEqual([{ path: 'deploy/k8s.yaml', lines: [0, 1] }])
    expect(d.asked).toEqual([])
  })

  // T024 review: `grep -r` on one file prints its path. Captured on macOS
  // 2026-11-07 from Claude Code's shell grep (ugrep 7.8.4) and /usr/bin/grep
  // (BSD grep 2.6.0), byte for byte the same.
  it('one file, the path printed anyway (grep -rn on one file)', async () => {
    const r = await parse(
      'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: qx7mkplzrvnwtyb',
      { oneFile: 'deploy/k8s.yaml', context: true }
    )
    expect(r.lines.map((l) => [l.kind, l.lineNumber, l.body])).toEqual([
      ['match', 2, '  - name: DB_PASSWORD'],
      ['context', 3, '    value: qx7mkplzrvnwtyb'],
    ])
  })
  it('one file, the path printed, no numbers (grep -r on one file)', async () => {
    const r = await parse(
      'deploy/k8s.yaml:  - name: DB_PASSWORD\ndeploy/k8s.yaml-    value: qx7mkplzrvnwtyb',
      { oneFile: 'deploy/k8s.yaml', context: true, numbered: false }
    )
    expect(r.lines.map((l) => l.body)).toEqual([
      '  - name: DB_PASSWORD',
      '    value: qx7mkplzrvnwtyb',
    ])
  })
  it('one file: a result where only some lines start with the path keeps them as text', async () => {
    const r = await parse('a.yaml:1:x\n2:y', { oneFile: 'a.yaml' })
    expect(r.lines.map((l) => l.body)).toEqual(
      ['a.yaml:1:x', 'y'].map((b, i) => (i ? b : undefined))
    )
  })
  it('one file, numbered: a line without its number is unresolved', async () => {
    const r = await parse('localhost:5432:*:postgres:pw', { oneFile: '.pgpass' })
    expect(r.lines[0]!.kind).toBe('unresolved')
  })

  it('one file, no numbers: the whole line is the body', async () => {
    const r = await parse('localhost:5432:*:postgres:pw', { oneFile: '.pgpass', numbered: false })
    expect(r.lines[0]).toMatchObject({
      kind: 'match',
      path: '.pgpass',
      body: 'localhost:5432:*:postgres:pw',
    })
  })

  it('a context line before the first match (-B)', async () => {
    const r = await parse(
      'a.yaml-1-password:\na.yaml:2:  Xk9mQ2vL7ZpQwR',
      { context: true },
      disk('a.yaml')
    )
    expect(r.runs).toEqual([{ path: 'a.yaml', lines: [0, 1] }])
  })
})

describe('parseSearchOutput: where the path ends', () => {
  it('a .pgpass line is cut at its path, not at a later :NN:', async () => {
    const r = await parse(
      'deploy/db.pgpass:1:localhost:5432:*:postgres:Xq9mK2pLzRvNw7',
      {},
      disk('deploy/db.pgpass')
    )
    expect(r.lines[0]).toMatchObject({
      kind: 'match',
      path: 'deploy/db.pgpass',
      lineNumber: 1,
      body: 'localhost:5432:*:postgres:Xq9mK2pLzRvNw7',
    })
  })

  it('a dated directory with dash-digit runs resolves only against the file', async () => {
    const r = await parse(
      'releases/2026-11-05/app-1-2.yaml:2:password: X\nreleases/2026-11-05/app-1-2.yaml-3-user: y',
      { context: true },
      disk('releases/2026-11-05/app-1-2.yaml')
    )
    expect(r.lines.map((l) => [l.kind, l.path])).toEqual([
      ['match', 'releases/2026-11-05/app-1-2.yaml'],
      ['context', 'releases/2026-11-05/app-1-2.yaml'],
    ])
  })

  it('a path with a space', async () => {
    const r = await parse('my app/c.yaml:1:password: X', {}, disk('my app/c.yaml'))
    expect(r.lines[0]).toMatchObject({ path: 'my app/c.yaml', body: 'password: X' })
  })

  it('no candidate names a file: unresolved', async () => {
    const r = await parse('deploy/db.pgpass:1:localhost:5432:*:postgres:pw', {}, disk())
    expect(r.lines[0]!.kind).toBe('unresolved')
    expect(r.runs).toEqual([])
  })

  it('two candidates both name a file: unresolved', async () => {
    const r = await parse('notes:1:2:password: X', {}, disk('notes', 'notes:1'))
    expect(r.lines[0]!.kind).toBe('unresolved')
  })

  it('a dated directory where a shorter prefix is a file too: unresolved', async () => {
    const r = await parse(
      'releases/2026-11-05/app-1-2.yaml-3-user: y',
      { context: true },
      disk('releases/2026-11-05/app-1-2.yaml', 'releases/2026-11-05/app')
    )
    expect(r.lines[0]!.kind).toBe('unresolved')
  })

  it('a path already resolved in this result is accepted without asking again', async () => {
    const d = disk('a.yaml')
    await parse('a.yaml:1:x\na.yaml:2:y\na.yaml:3:z', {}, d)
    expect(d.asked).toEqual(['/p/a.yaml'])
  })

  it('an absolute candidate is checked as written', async () => {
    const d = disk('/run/secrets/api_token')
    const r = await parse('/run/secrets/api_token:1:Tr0ub4dor&3xyz', {}, d)
    expect(r.lines[0]).toMatchObject({ path: '/run/secrets/api_token', body: 'Tr0ub4dor&3xyz' })
    expect(d.asked).toEqual(['/run/secrets/api_token'])
  })

  it('a ./ prefix is the base', async () => {
    const d = disk('deploy/k8s.yaml')
    const r = await parse('./deploy/k8s.yaml:2:x', {}, d)
    expect(r.lines[0]).toMatchObject({ path: './deploy/k8s.yaml' })
    expect(d.asked).toEqual(['/p/deploy/k8s.yaml'])
  })

  it('a candidate that climbs out of the base with .. is refused unasked', async () => {
    const d = disk('/etc/passwd')
    const r = await parse('../../etc/passwd:1:root:x:0:0', {}, d)
    expect(r.lines[0]!.kind).toBe('unresolved')
    expect(d.asked).toEqual([])
  })

  it('a Windows drive is not parsed specially: unresolved where the file is not here', async () => {
    const r = await parse('C:\\work\\project\\.env:1:DB_PASSWORD=x', {}, disk())
    expect(r.lines[0]!.kind).toBe('unresolved')
  })

  it('a secret file named for its key keeps its whole value as the body', async () => {
    const r = await parse('secrets/db_password:1:hunter2hunter2', {}, disk('secrets/db_password'))
    expect(r.lines[0]).toMatchObject({ path: 'secrets/db_password', body: 'hunter2hunter2' })
  })
})

describe('parseSearchOutput: runs', () => {
  const d = () => disk('a.yaml', 'b.yaml')
  it('a change of file ends a run, interleaved files never join', async () => {
    const r = await parse('a.yaml:1:k\nb.yaml:1:l\na.yaml-2-v', { context: true }, d())
    expect(r.runs).toEqual([
      { path: 'a.yaml', lines: [0] },
      { path: 'b.yaml', lines: [1] },
      { path: 'a.yaml', lines: [2] },
    ])
  })
  it('-- ends a run', async () => {
    const r = await parse('a.yaml:1:k\n--\na.yaml-2-v', { context: true }, d())
    expect(r.runs).toEqual([
      { path: 'a.yaml', lines: [0] },
      { path: 'a.yaml', lines: [2] },
    ])
  })
  it('a gap in numbering ends a run', async () => {
    const r = await parse('a.yaml:1:k\na.yaml:3:v', {}, d())
    expect(r.runs).toEqual([
      { path: 'a.yaml', lines: [0] },
      { path: 'a.yaml', lines: [1] },
    ])
  })
  it('an unresolved line ends a run', async () => {
    const r = await parse('a.yaml:1:k\nBinary file x matches\na.yaml:2:v', {}, d())
    expect(r.runs).toEqual([
      { path: 'a.yaml', lines: [0] },
      { path: 'a.yaml', lines: [2] },
    ])
  })
})

describe('parseSearchOutput: bounded work (research R6)', () => {
  it(`more than ${SEARCH_LIMITS.separators} candidate separators in a line: unresolved`, async () => {
    const many = `${'a:'.repeat(SEARCH_LIMITS.separators + 1)}`
    const r = await parse(`x.yaml:${many}`, { numbered: false }, disk('x.yaml'))
    expect(r.lines[0]!.kind).toBe('unresolved')
  })
  it('a path past the first 4 KB of a line is not looked for', async () => {
    const long = `${'d/'.repeat(SEARCH_LIMITS.prefix / 2)}f.yaml`
    const d = disk(long)
    const r = await parse(`${long}:1:x`, {}, d)
    expect(r.lines[0]!.kind).toBe('unresolved')
    expect(d.asked).toEqual([])
  })
  it(`at most ${SEARCH_LIMITS.checks} file checks per result; past them, unresolved`, async () => {
    const d = disk()
    const text = Array.from({ length: SEARCH_LIMITS.checks + 10 }, (_, i) => `f${i}.yaml:1:x`).join(
      '\n'
    )
    const r = await parse(text, {}, d)
    expect(d.asked.length).toBe(SEARCH_LIMITS.checks)
    expect(r.lines.every((l) => l.kind === 'unresolved')).toBe(true)
  })
  // T024 review: without line numbers every `:` is a candidate; once a file
  // is resolved, its later lines cost no new checks.
  it('a long unnumbered search of one file costs a few checks, and resolves to its end', async () => {
    const d = disk('config/app.yaml', 'deploy/k8s.yaml')
    const lines = Array.from({ length: 300 }, (_, i) => `config/app.yaml:  key${i}: v:${i}: w`)
    const r = await parse(
      [...lines, 'deploy/k8s.yaml:  - name: DB_PASSWORD', 'deploy/k8s.yaml-    value: x'].join(
        '\n'
      ),
      { numbered: false, context: true },
      d
    )
    expect(r.lines.every((l) => l.kind !== 'unresolved')).toBe(true)
    expect(d.asked.length).toBeLessThan(20)
  })
  it('each distinct path is checked once, a missing one too (cache)', async () => {
    const d = disk('a.yaml')
    await parse('gone.yaml:1:x\ngone.yaml:2:y\na.yaml:1:z\na.yaml:2:w', {}, d)
    expect(d.asked).toEqual(['/p/gone.yaml', '/p/a.yaml'])
  })
  it('a file check past the cap leaves a line with a resolved candidate unresolved too', async () => {
    const d = disk('a.yaml')
    const fill = Array.from({ length: SEARCH_LIMITS.checks }, (_, i) => `f${i}.yaml:1:x`)
    // a.yaml is known only once it is checked, and its line has a second
    // candidate (a.yaml:1:k) that cannot be checked any more.
    const r = await parse([...fill, 'a.yaml:1:k:2:v'].join('\n'), {}, d)
    expect(r.lines.at(-1)!.kind).toBe('unresolved')
  })

  // T005: linear time, against a same-size control (a ratio, not a constant).
  it('a 1 MB result with a 500 KB dash-digit line parses in linear time', async () => {
    const short = (n: number) =>
      Array.from({ length: n }, (_, i) => `src/a.ts:${i + 1}:const x = ${i}`)
    const dashed = `dist/app.min.js:1:${'-1-2'.repeat(125_000)}`
    const plain = `dist/app.min.js:1:${'abcd'.repeat(125_000)}`
    const time = async (text: string) => {
      const t = performance.now()
      await parse(text, { context: true }, disk('src/a.ts', 'dist/app.min.js'))
      return performance.now() - t
    }
    const lines = short(20_000)
    await time(lines.join('\n')) // warm
    const control = await time([...lines, plain].join('\n'))
    const dashedTime = await time([...lines, dashed].join('\n'))
    expect(dashedTime).toBeLessThan(control * 3 + 50)
    // And twice the lines take about twice the time, not four times.
    const half = await time(short(10_000).join('\n'))
    const full = await time(short(40_000).join('\n'))
    expect(full).toBeLessThan(half * 8 + 50)
  })
})

// Research R5: a shell command's output is search output only when the
// command is one plain `rg` or `grep`, optionally into `head`/`tail`.
describe('searchCommand', () => {
  it.each([
    ['rg -n -A1 DB_PASSWORD deploy', { numbered: true, context: true }],
    ['rg DB_PASSWORD', { numbered: false, context: false }],
    ["rg -A1 'DB_PASSWORD' deploy", { numbered: false, context: true }],
    ['rg --line-number --context=2 x src lib', { numbered: true, context: true }],
    ['rg -n -N x src', { numbered: false, context: false }],
    ['grep -rn -A 1 DB_PASSWORD deploy | head -n 20', { numbered: true, context: true }],
    ['grep -rni password config | tail -5', { numbered: true, context: false }],
    ['grep -r -e password -e token config', { numbered: false, context: false }],
    ['rg -i -g "*.yaml" password', { numbered: false, context: false }],
    // Quoted, these characters are the pattern's, not the shell's.
    ['rg -n "a;b" deploy', { numbered: true, context: false }],
    ["rg -n 'a|b' deploy | head -n 5", { numbered: true, context: false }],
    ['rg -n "it\'s" deploy', { numbered: true, context: false }],
    ["rg -n 'cost $5' deploy", { numbered: true, context: false }],
  ])('%s', (command, format) => {
    expect(searchCommand(command)).toMatchObject(format)
  })
  it('one path operand is the one-file candidate; none or several are not', () => {
    expect(searchCommand('grep -n -A1 DB_PASSWORD deploy/k8s.yaml')?.oneFile).toBe(
      'deploy/k8s.yaml'
    )
    expect(searchCommand('rg x secrets/db_password')?.oneFile).toBe('secrets/db_password')
    expect(searchCommand('rg -e x secrets/db_password')?.oneFile).toBe('secrets/db_password')
    expect(searchCommand('rg x')?.oneFile).toBeUndefined()
    expect(searchCommand('rg x a.yaml b.yaml')?.oneFile).toBeUndefined()
    // -H prints the path whatever the operands.
    expect(searchCommand('grep -H -n x a.yaml')?.oneFile).toBeUndefined()
  })
  it.each([
    'rg -n x | sort',
    'cd deploy && rg -n x .',
    'rg -n x; echo done',
    'rg -n x > out.txt',
    'rg --json x',
    'rg --heading x',
    'rg -l x',
    'rg -c x',
    'rg --files',
    'rg -o x',
    'rg --column x',
    'rg --vimgrep x',
    'grep -h x a b',
    'grep -L x a b',
    'grep x',
    'rg -n "$PATTERN" deploy',
    'rg -n `cat p` deploy',
    'FOO=1 rg x',
    'cat a.yaml',
    'egrep x a',
    'rg -n x | head -c 100',
    'rg -n x | tail -f',
    "rg -n 'x",
    'rg -n x \\\n deploy',
    // T024 review: a double-quoted word does not hide chaining after it.
    'rg "it\'s" ; cat notes.txt ; echo "\'"',
    'rg "x" ; cat notes.txt',
    'rg "$HOME" deploy',
    'rg "`id`" deploy',
    'rg "a\\"b" deploy',
    'rg x deploy # cat notes',
    'rg x (deploy)',
    'rg x deploy || cat notes.txt',
    'rg "x deploy',
  ])('not search output: %s', (command) => {
    expect(searchCommand(command)).toBeNull()
  })
})

describe('searchPath', () => {
  it.each([
    ['a/b.yaml', '/p/a/b.yaml'],
    ['./a/b.yaml', '/p/a/b.yaml'],
    ['/run/secrets/x', '/run/secrets/x'],
    ['../other/x', null],
    ['a/../../x', null],
    ['a\\..\\x', null],
    ['/run/../etc/x', null],
  ])('%s', (p, full) => {
    expect(searchPath('/p/', p)).toBe(full)
  })
})

// T024 review: the Grep tool's one-file path goes through the same resolver,
// so a `..` that climbs out of the project is refused there too.
describe('a one-file search outside the project', () => {
  it('is masked as before, not read as a mounted secret', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-074-up-')))
    try {
      const root = join(base, 'proj')
      mkdirSync(join(root, '.git'), { recursive: true })
      mkdirSync(join(base, 'other/secrets'), { recursive: true })
      writeFileSync(join(base, 'other/secrets/db_password'), 'xq9mk2plzrvnw7\n')
      const io: GuardIO = {
        read: async (p) => readFileSync(p, 'utf8'),
        write: async (p, t) => {
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, t)
        },
        exists: async (p) => existsSync(p),
        realPath: async (p) => p,
        isFile: async (p) => existsSync(p) && statSync(p).isFile(),
        fileSize: async (p) => (existsSync(p) ? statSync(p).size : undefined),
      }
      const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
      await g.load(root)
      const out = (await g.afterTool(
        'Grep',
        {
          tool: 'Grep',
          pattern: 'x',
          output_mode: 'content',
          path: '../other/secrets/db_password',
        },
        {
          result: {
            mode: 'content',
            numFiles: 1,
            filenames: [],
            content: '1:xq9mk2plzrvnw7',
            numLines: 1,
          },
        }
      )) as { result: { content: string } }
      expect(out.result.content).toBe('1:xq9mk2plzrvnw7')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
