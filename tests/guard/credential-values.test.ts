import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
import { applyMap, scrubSource, survivingSecrets } from '../../plugins/veilio-guard/lib/scrub.ts'
import type { FileKind } from '../../plugins/veilio-guard/vendor/engine/index.js'

// Security audit (spec 064 regression): a dictionary-word password is an
// ordinary word, which 064 shows as written - but as the value of a
// credential-named key it is a password, and it never reaches the model.
const FILES: [string, string, string, FileKind?][] = [
  ['auto', 'spring:\n  datasource:\n    password: sunshine\n', 'sunshine', 'yaml'],
  ['auto', 'password: sunshine\n', 'sunshine'],
  ['typescript', 'export const db = { user: "ledger", password: "dragon" }\n', 'dragon'],
  ['python', 'DATABASES = {"default": {"PASSWORD": "monkey"}}\n', 'monkey'],
  ['python', 'SECRET_KEY = "phoenix"\n', 'phoenix'],
  ['auto', 'DB_PASSWORD=sunshine\n', 'sunshine'],
  ['auto', 'DB_PASSWORD=sunshine\n', 'sunshine', 'dotenv'],
  ['auto', 'DB_PASSWORD: sunshine\n', 'sunshine', 'yaml'],
  ['auto', 'export DB_PASSWORD=sunshine\n', 'sunshine', 'shell'],
]

describe('scrubSource: a file Claude reads', () => {
  it.each(FILES)('%s %j does not show %s', (language, text, word, fileKind) => {
    const r = scrubSource(text, {}, language as 'auto', new Set(), fileKind)
    expect(r.text).not.toMatch(new RegExp(`\\b${word}\\b`))
    expect(survivingSecrets(r.text, r.additions)).toEqual([])
  })

  it('the control: an ordinary word that is not a credential value stays readable', () => {
    const r = scrubSource('const password_hint = "sunshine is a word"\n', {}, 'typescript')
    expect(r.text).toContain('sunshine is a word')
  })
})

describe('applyMap: command output, with the word in the map', () => {
  const MAP = { __VAR__1: 'sunshine', __VAR__2: 'monkey' }
  it.each([
    ['DB_PASSWORD=sunshine', 'sunshine'],
    ['password: sunshine', 'sunshine'],
    ['DATABASES = {"default": {"PASSWORD": "monkey"}}', 'monkey'],
  ])('%j does not show %s', (text, word) => {
    expect(applyMap(text, MAP)).not.toContain(word)
  })

  it('the control: the same word in prose stays readable', () => {
    expect(applyMap('a sunshine day; password_hint = "sunshine is a word"', MAP)).toBe(
      'a sunshine day; password_hint = "sunshine is a word"'
    )
  })
})

// Security review of round 1: with an empty map, nothing could be written over
// a credential value in command output - the rule must not depend on the map.
const OUTPUT = [
  ['DB_PASSWORD=sunshine', 'sunshine'],
  ['{"password": "dragon"}', 'dragon'],
  ['SECRET_KEY = "phoenix"', 'phoenix'],
] as const

describe('applyMap: command output, with an empty map', () => {
  it.each(OUTPUT)('%j does not show %s', (text, word) => {
    const out = applyMap(text, {})
    expect(out).not.toMatch(new RegExp(`\\b${word}\\b`))
    expect(out).toContain('__REDACTED_CREDENTIAL_')
  })

  it('the controls: prose, a hint and a reference stay as written', () => {
    for (const text of [
      'a sunshine day',
      'password_hint = "sunshine is a word"',
      'export DB_PASSWORD=$DB_PASSWORD',
    ])
      expect(applyMap(text, {})).toBe(text)
  })
})

describe("the guard's command output, with no map", () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-guard-cv-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const io: GuardIO = {
    read: async (p) => readFileSync(p, 'utf8'),
    write: async (p, t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
    },
    exists: async (p) => existsSync(p),
    realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
  }
  const stdout = OUTPUT.map(([t]) => t).join('\n')

  it('a command result shows none of the values', async () => {
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await guard.load(root)
    const out = JSON.stringify(
      await guard.afterTool(
        'Bash',
        { tool: 'Bash', command: 'cat config' },
        { result: { stdout, stderr: '', interrupted: false, isImage: false } }
      )
    )
    for (const [, word] of OUTPUT) expect(out).not.toMatch(new RegExp(`\\b${word}\\b`))
  })

  it('a failed command (masked as a message) shows none of them either', async () => {
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await guard.load(root)
    const out = JSON.stringify(
      await guard.afterTool(
        'Bash',
        { tool: 'Bash', command: 'cat config' },
        { result: `Error: Exit code 1\n${stdout}`, text: `Exit code 1\n${stdout}`, isError: true }
      )
    )
    for (const [, word] of OUTPUT) expect(out).not.toMatch(new RegExp(`\\b${word}\\b`))
  })
})

// Security review of round 1: syntaxes the first rule missed, in a file the
// guard reads and in command output with an empty map.
const MORE: [string, string, string, FileKind?][] = [
  ['python', 'app.config["SECRET_KEY"] = "phoenix"\n', 'phoenix'],
  ['python', 'os.environ["PGPASSWORD"] = "sunshine"\n', 'sunshine'],
  ['ruby', "config[:password] = 'sunshine'\n", 'sunshine'],
  ['php', "<?php\n$password = 'sunshine';\n", 'sunshine'],
  ['auto', 'PASSWORD=SUNSHINE\n', 'SUNSHINE'],
  ['auto', 'password: `sunshine`\n', 'sunshine'],
  ['typescript', 'const password = `sunshine`;\n', 'sunshine'],
  ['auto', '<password>sunshine</password>\n', 'sunshine'],
  ['java', '<entry key="password">sunshine</entry>\n', 'sunshine'],
  ['auto', 'env:\n  - name: DB_PASSWORD\n    value: sunshine\n', 'sunshine', 'yaml'],
  ['auto', 'ENV PASSWORD sunshine\n', 'sunshine', 'shell'],
  ['php', "<?php\ndefine('DB_PASSWORD','sunshine');\n", 'sunshine'],
  ['go', 'os.Setenv("DB_PASSWORD","sunshine")\n', 'sunshine'],
  ['python', 'pw = "sunshine"\n', 'sunshine'],
  ['auto', 'passwords: sunshine\n', 'sunshine', 'yaml'],
  // A quoted `$` value is a value, not a reference (security review).
  ['auto', 'password: "$unshine"\n', 'unshine'],
  ['auto', "PASSWORD='$ecret123'\n", 'ecret123'],
]

describe('more credential syntaxes (security review of round 1)', () => {
  it.each(MORE)('a Read of %s %j does not show %s', (language, text, word, fileKind) => {
    const r = scrubSource(text, {}, language as 'auto', new Set(), fileKind)
    expect(r.text).not.toMatch(new RegExp(`\\b${word}\\b`))
  })

  it.each(MORE)('command output (%s) %j does not show %s', (_language, text, word) => {
    expect(applyMap(text, {})).not.toMatch(new RegExp(`\\b${word}\\b`))
  })

  it.each([
    'author: sunshine',
    '<author>sunshine</author>',
    '<entry key="password_hint">sunshine</entry>',
    'ENV AUTHOR sunshine',
    "define('AUTHOR','sunshine');",
    'env:\n  - name: AUTHOR\n    value: sunshine',
    'const animal = monkey',
  ])('the control %j stays as written in command output', (text) => {
    expect(applyMap(text, {})).toBe(text)
  })
})

describe('exemptions fail closed in command output (security review of round 2)', () => {
  it.each([
    ['key: sunshine', 'sunshine'],
    ['KEY=sunshine', 'sunshine'],
    ['AZURE_STORAGE_KEY=sunshine', 'sunshine'],
    ['ALGOLIA_SEARCH_KEY=sunshine', 'sunshine'],
    ['HASH_KEY=sunshine', 'sunshine'],
    ['S3_OBJECT_KEY=sunshine', 'sunshine'],
    ['password: password', ': password'],
  ])('%j does not show the value', (text, shown) => {
    expect(applyMap(text, {})).not.toContain(shown)
  })

  it.each(['<li key="sunshine">x</li>', 'PRIMARY_KEY=id'])('%j stays as written', (text) => {
    expect(applyMap(text, {})).toBe(text)
  })
})
