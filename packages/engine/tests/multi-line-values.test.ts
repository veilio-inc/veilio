import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'
import {
  LINES,
  MULTI_LINE,
  MULTI_LINE_KEPT,
  MULTI_LINE_PINNED,
  pathLanguage,
} from './fixtures/baseline-corpus.js'
import { expectRedacted, holds } from './fixtures/credential-checks.js'

// The whole value is redacted, not its first line: a YAML block scalar or a
// quoted scalar that runs over lines, string literals joined over a line
// break, and a literal that starts on the line after its name. What follows a
// credential name and is not its literal value is read as before.

const [L1, L2, L3] = LINES
const YAML = pathLanguage('a.yml')
const TS = pathLanguage('a.ts')
const PY = pathLanguage('a.py')

describe('a credential value over several lines is redacted whole', () => {
  it.each(MULTI_LINE)('$name', ({ path, text, lines }) => {
    const { anonymized } = expectRedacted(text, pathLanguage(path), lines)
    // What stands after the value is left as it was.
    if (text.includes('name: x')) expect(anonymized).toContain('name: x')
  })

  // `also`: what the redaction takes with the value - a block's line is
  // redacted whole, and a tag before the header is read as a value, as before.
  it.each<[string, string, string[]]>([
    [
      'a comment after the block',
      `password: |\n  ${L1}\n  ${L2}\n# rotate monthly\nport: 8080\n`,
      [],
    ],
    ['a blank line inside the block', `password: |\n  ${L1}\n\n  ${L2}\nport: 8080\n`, []],
    [
      'a line of the block that reads as a key',
      `password: |\n  user: ${L1}\n  ${L2}\nport: 8080\n`,
      ['user: '],
    ],
    [
      'a line of the block that starts with #',
      `password: |\n  #${L1}\n  ${L2}\nport: 8080\n`,
      ['#'],
    ],
    ['a block in a list item', `- name: db\n  token: >-\n    ${L1}\n    ${L2}\nport: 8080\n`, []],
    ['a block behind a tag', `password: !!str |\n  ${L1}\n  ${L2}\nport: 8080\n`, ['!!str']],
    ['lines that end in CR', `password: |\r\n  ${L1}\r\n  ${L2}\r\nport: 8080\r\n`, []],
    [
      'a single-quoted scalar over three lines',
      `api_key: '${L1}\n  ${L2}\n  ${L3}'\nport: 8080\n`,
      [],
    ],
  ])('YAML: %s', (_, text, also) => {
    const lines = [L1, L2, L3].filter((line) => text.includes(line))
    const { anonymized } = expectRedacted(text, YAML, lines, also)
    expect(anonymized).toMatch(/port: 8080\r?\n$/)
  })

  it.each<[string, string, typeof TS]>([
    ['a plus at the start of the next line', `const password = "${L1}"\n  + "${L2}";\n`, TS],
    ['three literals', `const secret = "${L1}" +\n  "${L2}" +\n  "${L3}";\n`, TS],
    ['a value after an opening parenthesis', `const password = (\n  "${L1}"\n);\n`, TS],
    ['a quoted property name', `const o = {\n  "password":\n    "${L1}",\n  port: 1\n}\n`, TS],
    ['a Python dictionary entry', `o = {\n  "password":\n    "${L1}",\n}\n`, PY],
    ['a name with letters outside A-Z', `const hasło: string =\n  "${L1}";\n`, TS],
  ])('code: %s', (_, text, options) => {
    expectRedacted(
      text,
      options,
      [L1, L2, L3].filter((line) => text.includes(line))
    )
  })
})

describe('shapes 1.19.2 redacts whole already', () => {
  it.each(MULTI_LINE_PINNED)('$name', ({ path, text, lines }) => {
    // One token may stand for the lines and the breaks between them.
    const { anonymized, map } = anonymize(text, pathLanguage(path))
    expect(anonymized).toContain('__REDACTED_')
    for (const line of lines) {
      expect(holds(anonymized, line)).toBe(false)
      expect(holds(Object.values(map).join('\n'), line)).toBe(false)
    }
  })
})

describe('what is not the literal value of the name is read as before', () => {
  it.each(MULTI_LINE_KEPT)('$name', ({ path, text }) => {
    const { anonymized } = anonymize(text, pathLanguage(path))
    expect(anonymized).not.toContain('__REDACTED_')
  })

  it.each<[string, string, typeof TS]>([
    ['the next key of a mapping, quoted', `password: "${L1}"\n"label": "${L2}"\n`, YAML],
    ['a statement that starts with a literal', `const password = "${L1}"\n"${L2}".trim()\n`, TS],
    [
      'the next entry of an object',
      `const o = {\n  password: "${L1}",\n  "label": "${L2}"\n}\n`,
      TS,
    ],
    ['a comparison over two lines', `if (mode ==\n  "${L2}") run(secretName)\n`, TS],
    ['a message joined in a call', `throw new TokenError("${L1}" +\n  "${L2}")\n`, TS],
    ['a message under a call', `throw new TokenError(\n  "${L2}"\n)\n`, TS],
    ['a case label', `switch (kind) {\n  case 'token':\n    "${L2}"\n}\n`, TS],
    ['a quote that never closes', `password: "${L1}\nlabel: ${L2}\nport: 8080\n`, YAML],
  ])('%s', (_, text, options) => {
    const { anonymized, map } = anonymize(text, options)
    // The second value is no credential: masked, restorable, as before.
    expect(holds(anonymized, L2)).toBe(false)
    expect(Object.values(map).join('\n')).toContain(L2)
  })
})

it('a stray quote does not run into the next key, whatever letters the key has', () => {
  // The quote closes only inside the next line's own value: that line is a
  // key of its own, so the first value ends on its line, as before.
  for (const key of ['label', 'opis usługi', 'περιγραφή', 'my label']) {
    const text = `password: "${L1}\n${key}: "${L2}"\nport: 8080\n`
    const { anonymized, map } = anonymize(text, YAML)
    expect(restore(anonymized, map).restored, key).toContain(`${key}: "${L2}"`)
  }
})

describe('a plain value that carries on over lines', () => {
  it.each<[string, string, typeof YAML]>([
    ['a YAML plain scalar', `password: ${L1}\n  ${L2}\n  ${L3}\nport: 8080\n`, YAML],
    [
      'a YAML plain scalar that starts on the next line',
      `password:\n  ${L1}\n  ${L2}\nport: 8080\n`,
      YAML,
    ],
    ['a YAML plain scalar, nested', `db:\n  password: ${L1}\n    ${L2}\n  port: 8080\n`, YAML],
    [
      'an INI value after a backslash',
      `password = ${L1}\\\n  ${L2}\nport = 8080\n`,
      { fileKind: 'ini' },
    ],
    [
      'a properties value after a backslash',
      `password=${L1}\\\n  ${L2}\\\n  ${L3}\nport=8080\n`,
      { fileKind: 'ini' },
    ],
  ])('%s is redacted whole', (_, text, options) => {
    const lines = [L1, L2, L3].filter((line) => text.includes(line))
    const { anonymized, map } = anonymize(text, options)
    for (const line of lines) {
      expect(holds(anonymized, line)).toBe(false)
      expect(holds(Object.values(map).join('\n'), line)).toBe(false)
    }
    expect(anonymized).toMatch(/port ?[:=] ?8080\n$/)
  })

  it.each<[string, string, typeof YAML]>([
    ['a key on the next line', `password: ${L1}\n  label: ${L2}\n`, YAML],
    ['a list item on the next line', `password: ${L1}\n  - ${L2}\n`, YAML],
    ['a line indented no deeper', `password: ${L1}\n${L2}\n`, YAML],
    ['an indented line in a document', `password: ${L1}\n    ${L2}\n`, { fileKind: 'text' }],
    [
      'a path that ends in a backslash',
      `password_file = C:\\keys\\\nlabel = ${L2}\n`,
      { fileKind: 'ini' },
    ],
    ['under an ordinary key', `notes = ${L1}\\\n  ${L2}\n`, { fileKind: 'ini' }],
  ])('%s is read as before', (_, text, options) => {
    const { anonymized, map } = anonymize(text, options)
    expect(holds(anonymized, L2)).toBe(false)
    expect(Object.values(map).join('\n')).toContain(L2)
  })

  // A stated limit (SECURITY.md): a list under a credential-named key is as
  // often a list of names (`secrets:` in a compose file) as of values.
  it('a list under a credential-named key is masked, not redacted', () => {
    for (const text of [
      `passwords:\n  - ${L1}\nport: 8080\n`,
      `secrets:\n  - |\n    ${L1}\nport: 8080\n`,
    ]) {
      const { anonymized, map } = anonymize(text, YAML)
      expect(holds(anonymized, L1)).toBe(false)
      expect(Object.values(map)).toContain(L1)
    }
  })
})

it('an INI value carried on by backslashes is redacted the same on every line', () => {
  const { anonymized } = anonymize(`password = ${L1}\\\n  ${L2}\\\n  ${L3}\nport = 8080\n`, {
    fileKind: 'ini',
  })
  expect(anonymized).toMatch(
    /^password = __REDACTED_CREDENTIAL_1__\n {2}__REDACTED_CREDENTIAL_2__\n {2}__REDACTED_CREDENTIAL_3__\nport = 8080\n$/
  )
})
