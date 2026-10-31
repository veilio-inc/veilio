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

  // Round 3: a string is a value - its ordinary words are masked; a name stays.
  it('the control: an ordinary word stays readable as a name, not in a string', () => {
    const r = scrubSource('const sunshine = "sunshine is a word"\n', {}, 'typescript')
    expect(r.text).toMatch(/^const sunshine = "__[A-Z]+__\d+ is a __[A-Z]+__\d+"\n$/)
    const hint = scrubSource('const password_hint = "sunshine is a word"\n', {}, 'typescript')
    expect(hint.text).toContain('"__REDACTED_CREDENTIAL_')
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

  // Round 3: in prose it stays readable; in a quoted value it is written over.
  it('the control: the same word in prose stays readable, in a value it does not', () => {
    expect(applyMap('a sunshine day; mood = "sunshine is a word"', MAP)).toBe(
      'a sunshine day; mood = "__VAR__1 is a word"'
    )
    expect(applyMap('a sunshine day; MOOD=sunshine', MAP)).toBe('a sunshine day; MOOD=__VAR__1')
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

  it('the controls: prose and a `$NAME` or `${NAME}` reference stay as written', () => {
    for (const text of [
      'a sunshine day',
      'export DB_PASSWORD=$DB_PASSWORD',
      'export DB_PASSWORD=${DB_PASSWORD}',
    ])
      expect(applyMap(text, {})).toBe(text)
  })

  // Round 3: the key CONTAINS a credential word, the value is whole up to its
  // delimiter, and only `$NAME`/`${NAME}` is a reference.
  it.each([
    ['password_hint = "sunshine is a word"', 'sunshine is a word'],
    ['DB_PASSWORD=ADMIN_PASSWORD', 'ADMIN_PASSWORD'],
    ['DB_PASSWORD_PROD="sunshine"', 'sunshine'],
    ['DB_PASSWORD=sunshine ./run', 'sunshine'],
    ['conn = "Server=x;Password=sunshine;"', 'sunshine'],
    ['const DB_PASS = "Summer2024!"', 'Summer2024'],
    ['<add key="DbPassword" value="sunshine"/>', 'sunshine'],
    ['<property name="password" value="sunshine"/>', 'sunshine'],
    ['password:\n  sunshine', 'sunshine'],
    ['dsn: password=sunshine dbname=y', 'sunshine'],
  ])('%j does not show %s', (text, value) => {
    const out = applyMap(text, {})
    expect(out).not.toContain(value)
    expect(out).toContain('__REDACTED_CREDENTIAL_')
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

  it.each(['const animal = monkey', 'a monkey and a sunshine'])(
    'the control %j stays as written in command output',
    (text) => {
      expect(applyMap(text, {})).toBe(text)
    }
  )

  // Round 3: a key CONTAINS a credential word (`author`, `password_hint`).
  it.each([
    'author: sunshine',
    '<author>sunshine</author>',
    '<entry key="password_hint">sunshine</entry>',
    'ENV AUTHOR sunshine',
    "define('AUTHOR','sunshine');",
    'env:\n  - name: AUTHOR\n    value: sunshine',
  ])('the former control %j hides sunshine in command output', (text) => {
    expect(applyMap(text, {})).not.toContain('sunshine')
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

  // Round 3: a `key` attribute names a credential by CONTAINS; two characters
  // are no secret.
  it('PRIMARY_KEY=id stays as written; <li key="sunshine"> does not', () => {
    expect(applyMap('PRIMARY_KEY=id', {})).toBe('PRIMARY_KEY=id')
    expect(applyMap('<li key="sunshine">x</li>', {})).not.toContain('sunshine')
  })
})
