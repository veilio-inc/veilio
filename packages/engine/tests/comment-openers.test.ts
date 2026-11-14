import { describe, it, expect } from 'vitest'
import {
  anonymize,
  detectCredentials,
  measureCommentExposure,
  restore,
  valuePositions,
} from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'

// Spec 094: `//` and `/*` are comment openers of some languages only.
// - In a shell script, a Dockerfile, YAML, `.env`, INI and plain-text files
//   they open nothing, whatever language is named with them.
// - In text whose language is only detected, `/*` opens nothing; `//` is still
//   a line comment (it ends with its line).
// - In any language, a block opener with no closer after it opens nothing.
// What used to be read as a comment there is code, and is masked.

type Kind = NonNullable<AnonymizeOptions['fileKind']>

const FILES: readonly (readonly [string, string, Kind, string, readonly string[]])[] = [
  [
    'a shell script, a glob in a function',
    'd.sh',
    'shell',
    '#!/bin/bash\nfunction deploy() {\n  local target=$1\n  rm -rf build/*\n  acme_refunds=1\n  settleInvoice "$acmeCorp"\n}\nexport AcmePay\n',
    ['acme_refunds', 'settleInvoice', 'acmeCorp', 'AcmePay'],
  ],
  [
    'a shell script, a glob at the top level',
    'run.sh',
    'shell',
    'set -e\nrm -rf build/*\ncustomerTotal=1\ndeploy_AcmePay() { settleInvoice "$acme_corp"; }\ndeploy_AcmePay\n',
    ['customerTotal', 'deploy_AcmePay', 'settleInvoice', 'acme_corp'],
  ],
  [
    'a Dockerfile',
    'Dockerfile',
    'shell',
    'COPY packages/*/package.json ./\nRUN ./acme_refunds --AcmePay settleInvoice\n',
    ['acme_refunds', 'AcmePay', 'settleInvoice'],
  ],
  [
    'a YAML file',
    'ci.yml',
    'yaml',
    'paths:\n  - src/**\njobs:\n  acme_refunds:\n    name: AcmePay settleInvoice\n',
    ['acme_refunds', 'AcmePay', 'settleInvoice'],
  ],
  [
    'a Makefile',
    'Makefile',
    'text',
    'SOURCES := src/*.c\n\nacme_refunds: $(SOURCES)\n\t./settleInvoice --AcmePay\n',
    ['acme_refunds', 'settleInvoice', 'AcmePay'],
  ],
  [
    'an INI file',
    'app.ini',
    'ini',
    '[paths]\ninclude = src/*\nowner = AcmePay\ntask = settleInvoice\n',
    ['AcmePay', 'settleInvoice'],
  ],
]

/** Every name is a placeholder in the output and a value of the map, and the
 *  text comes back exactly. */
const masksAll = (code: string, options: AnonymizeOptions, names: readonly string[]): void => {
  const { anonymized, map } = anonymize(code, options)
  for (const name of names) {
    expect(anonymized).not.toMatch(new RegExp(`(?<![\\w$])${name}(?![\\w$])`))
    // A shell variable is held with its `$`.
    expect(Object.values(map).map((value) => value.replace(/^\$/, ''))).toContain(name)
  }
  expect(restore(anonymized, map).restored).toBe(code)
}

describe('a glob does not open a comment', () => {
  for (const [label, path, fileKind, code, names] of FILES) {
    it(`${label}: by its kind`, () => masksAll(code, { fileKind }, names))
    it(`${label}: by its path`, () => masksAll(code, { path }, names))
    it(`${label}: with no kind and no language`, () => masksAll(code, {}, names))
    it(`${label}: the kind wins over a named language`, () =>
      masksAll(code, { fileKind, language: 'typescript' }, names))
    it(`${label}: no comment is counted`, () => {
      expect(anonymize(code, { fileKind }).comments.total).toBe(0)
      expect(anonymize(code, { path, language: 'c' }).comments.total).toBe(0)
    })
  }
})

describe('`//` in a file that is not source code', () => {
  const code = 'set -e\necho copy //AcmePay/settleInvoice\nacme_refunds=1\n'
  const names = ['AcmePay', 'settleInvoice', 'acme_refunds']

  it('opens nothing in a shell script', () => {
    masksAll(code, { fileKind: 'shell' }, names)
    masksAll(code, { path: 'copy.sh' }, names)
    masksAll(code, { fileKind: 'shell', language: 'java' }, names)
    expect(anonymize(code, { fileKind: 'shell' }).comments.total).toBe(0)
  })

  it.each(['yaml', 'dotenv', 'ini', 'text'] as const)('opens nothing in a %s file', (fileKind) =>
    masksAll('owner: x // AcmePay settleInvoice\n', { fileKind }, ['AcmePay', 'settleInvoice'])
  )

  it('is still a line comment where the language is only detected', () => {
    const text = 'const customerTotal = 1 // AcmePay settles\nconst acme_refunds = 2\n'
    const { anonymized, map, comments } = anonymize(text)
    expect(anonymized).toContain('// AcmePay settles\n')
    expect(Object.values(map)).toEqual(['customerTotal', 'acme_refunds'])
    expect(comments.total).toBe(1)
  })
})

describe('a block opener where the language is only detected', () => {
  it('opens nothing, closed or not', () => {
    masksAll('const customerTotal = 1 /* AcmePay */\nconst acme_refunds = 2\n', {}, [
      'customerTotal',
      'AcmePay',
      'acme_refunds',
    ])
    masksAll('const customerTotal = 1 /* AcmePay\nconst acme_refunds = 2\n', {}, [
      'customerTotal',
      'AcmePay',
      'acme_refunds',
    ])
  })

  it('is a comment in a file whose extension names the language', () => {
    const code = '/* AcmePay */ const customerTotal = 1\n'
    for (const options of [{ path: 'src/total.ts' }, { language: 'typescript' }] as const) {
      const { anonymized, map, comments } = anonymize(code, options)
      expect(anonymized).toBe('/* AcmePay */ const __VAR__1 = 1\n')
      expect(map).toEqual({ __VAR__1: 'customerTotal' })
      expect(comments.total).toBe(1)
    }
  })
})

describe('a block opener that is never closed', () => {
  const JSX =
    'export const Docs = () => <p>docs at /* not a comment</p>; const AcmePay = settleInvoice(acme_refunds);\n'
  const names = ['AcmePay', 'settleInvoice', 'acme_refunds']

  it('opens nothing in JSX text', () => {
    masksAll(JSX, { language: 'typescript' }, names)
    masksAll(JSX, { path: 'Docs.tsx' }, names)
    masksAll(JSX, {}, names)
    expect(anonymize(JSX, { language: 'typescript' }).comments.total).toBe(0)
  })

  it.each(['c', 'java', 'go', 'rust', 'csharp', 'php', 'sql', 'typescript'] as const)(
    'opens nothing in %s, on the lines after it either',
    (language) =>
      masksAll('total = 1; /* note\nAcmePay = settleInvoice(acme_refunds);\n', { language }, names)
  )

  it('opens nothing in Ruby', () =>
    masksAll(
      '=begin\nclass AcmePay\n  def settleInvoice(acme_refunds)\n  end\nend\n',
      { language: 'ruby' },
      names
    ))

  it('leaves the closed comment before it a comment', () => {
    const code = '/* kept as written */ const customerTotal = 1 /* AcmePay\nsettleInvoice()\n'
    const { anonymized, map, comments } = anonymize(code, { language: 'typescript' })
    expect(anonymized.startsWith('/* kept as written */ const ')).toBe(true)
    expect(comments.total).toBe(1)
    for (const name of ['customerTotal', 'AcmePay', 'settleInvoice']) {
      expect(anonymized).not.toContain(name)
      expect(Object.values(map)).toContain(name)
    }
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('costs no more for 200,000 of them than their length', () => {
    // Eight times the text: linear is 8, quadratic 64. The fastest of three.
    for (const [opener, language] of [
      ['a /* b\n', 'typescript'],
      ['=begin\nb\n', 'ruby'],
    ] as const) {
      const fastest = (code: string): number => {
        let best = Infinity
        for (let run = 0; run < 3; run++) {
          const start = performance.now()
          expect(measureCommentExposure(code, language).total).toBe(0)
          best = Math.min(best, performance.now() - start)
        }
        return best
      }
      const small = fastest(opener.repeat(25_000))
      expect(fastest(opener.repeat(200_000))).toBeLessThan(Math.max(small, 1) * 24)
    }
  }, 30_000)
})

describe('in a named language, what was read before is read the same', () => {
  it('a closed block comment and a line comment stay as written', () => {
    const code =
      '/* AcmePay settles */ const customerTotal = 1 // settleInvoice later\nconst acme_refunds = 2\n'
    const { anonymized, map, comments } = anonymize(code, { language: 'typescript' })
    expect(anonymized).toBe(
      '/* AcmePay settles */ const __VAR__1 = 1 // settleInvoice later\nconst __VAR__2 = 2\n'
    )
    expect(map).toEqual({ __VAR__1: 'customerTotal', __VAR__2: 'acme_refunds' })
    expect(comments.total).toBe(2)
  })

  it('an opener inside a string or a regex literal opens nothing', () => {
    const code =
      'const glob = "src/*"; const pattern = /\\/*x/\nconst AcmePay = settleInvoice(glob, pattern)\n'
    const { anonymized, map, comments } = anonymize(code, { language: 'typescript' })
    expect(anonymized).toMatch(/"\w+\/\*";/)
    expect(anonymized).toContain('/\\/*x/')
    expect(comments.total).toBe(0)
    for (const name of ['AcmePay', 'settleInvoice']) {
      expect(anonymized).not.toContain(name)
      expect(Object.values(map)).toContain(name)
    }
    expect(restore(anonymized, map).restored).toBe(code)
  })
})

describe('every reader of the text reads it as `anonymize` does', () => {
  const guessed = 'const total = base /* c\nconst note = "paymentGateway fails"\n'
  const shell = 'rm -rf build/*\necho "paymentGateway fails" // "AcmePay settles"\n'

  it('valuePositions finds the values after a glob', () => {
    expect(valuePositions(guessed).map((v) => v.value)).toEqual(['paymentGateway fails'])
    expect(valuePositions(guessed, { language: 'typescript' }).map((v) => v.value)).toEqual([
      'paymentGateway fails',
    ])
    for (const options of [{ fileKind: 'shell' }, { path: 'd.sh' }] as const)
      // The run after `//` is code, not a string: its names are masked as names.
      expect(valuePositions(shell, options).map((v) => v.value)).toEqual(['paymentGateway fails'])
  })

  it('detectCredentials reports a credential-named value after a glob', () => {
    const code = 'const total = base /* c\nconst settings = { passphrase: `Tr0ub4dor zebra91` }\n'
    for (const options of [{}, { language: 'typescript' }] as const)
      expect(detectCredentials(code, options).map((f) => f.line)).toEqual([2])
  })

  it('the comment summary counts what `anonymize` left as written', () => {
    const closed = 'const customerTotal = 1 /* AcmePay */ + 2 // later\n'
    const rows: readonly (readonly [string, AnonymizeOptions])[] = [
      [guessed, {}],
      [guessed, { language: 'typescript' }],
      [closed, {}],
      [closed, { language: 'typescript' }],
      [closed, { path: 'total.ts' }],
      [closed, { fileKind: 'shell' }],
      [closed, { path: 'total.sh', language: 'typescript' }],
      [shell, { fileKind: 'shell' }],
      [shell, { path: 'd.sh' }],
    ]
    for (const [code, options] of rows) {
      const { language, fileKind, path } = options
      expect(measureCommentExposure(code, language, { fileKind, path })).toEqual(
        // The same count on text with no name to replace: comments hold none here
        // that the code also holds, so the masked text has the same comments.
        anonymize(code, options).comments
      )
    }
    expect(measureCommentExposure(guessed).total).toBe(0)
    expect(measureCommentExposure(closed).total).toBe(1)
    expect(measureCommentExposure(closed, 'typescript').total).toBe(2)
    expect(measureCommentExposure(closed, 'typescript', { fileKind: 'shell' }).total).toBe(0)
  })
})

// What used to be a comment is code now, but it still ends where it ended: a
// quote inside it opens no string, so the strings after it are the strings
// they were, and a `//`, `#` or `--` inside one of them opens no comment.
describe('a quote in what used to be a comment moves no string after it', () => {
  const rows: readonly (readonly [string, string, AnonymizeOptions])[] = [
    ['a closed block, detected', "/* don't */ const p = '//AcmePay/settleInvoice'\n", {}],
    [
      'a closed block, detected, strings that span lines',
      "<?php\n/* it's */\n$a = 1;\n$c = '#AcmePay settleInvoice';\n",
      {},
    ],
    [
      'a closed block in a text file',
      "/* it's */\nkey = 1\nname = '#AcmePay settleInvoice'\n",
      { fileKind: 'text', language: 'php' },
    ],
    [
      'a `//` line in a text file',
      "// it's\nkey = 1\nname = '#AcmePay settleInvoice'\n",
      { fileKind: 'text', language: 'php' },
    ],
    [
      'a backtick in a closed block, detected',
      'const a = 1 /* a ` tick */\nconst b = `x`\nconst c = 2 // note\nconst d = `${AcmePay} // ${settleInvoice}`\n',
      {},
    ],
  ]
  it.each(rows)('%s', (_, code, options) => {
    const { anonymized, map } = anonymize(code, options)
    expect(anonymized).not.toMatch(/AcmePay|settleInvoice/)
    expect(Object.values(map)).toEqual(expect.arrayContaining(['AcmePay', 'settleInvoice']))
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('a name in the former comment is masked all the same', () => {
    const code = "/* AcmePay doesn't settle */ const customerTotal = 1\n"
    const { anonymized, map } = anonymize(code)
    expect(anonymized).not.toContain('AcmePay')
    expect(Object.values(map)).toContain('AcmePay')
    expect(restore(anonymized, map).restored).toBe(code)
  })
})
