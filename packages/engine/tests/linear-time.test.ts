import { describe, it, expect } from 'vitest'
import {
  anonymize,
  guessLanguage,
  isRawOnly,
  parseSymbolMap,
  restore,
  scanSecrets,
  valuePositions,
} from '../src/index.js'

// Every scanner that walks input text reads it in linear time. Each row is a
// hostile text and the scanner it is given to, timed at size n and 2n: linear
// work doubles, quadratic work takes four times as long, and the row fails
// past 2.5 times. A new loop over input text adds its hostile input here as
// one row. `n` is chosen per row so a run takes milliseconds.

type Scanner = (text: string) => unknown
const SCANNERS = {
  // The whole pass: lexing of comments and strings, the value positions, the
  // credential rules, masking.
  typescript: (text) => anonymize(text, { language: 'typescript' }),
  python: (text) => anonymize(text, { language: 'python' }),
  yaml: (text) => anonymize(text, { fileKind: 'yaml' }),
  shell: (text) => anonymize(text, { fileKind: 'shell' }),
  env: (text) => anonymize(text, { fileKind: 'dotenv' }),
  ini: (text) => anonymize(text, { fileKind: 'ini' }),
  pasted: (text) => anonymize(text),
  // Its parts, alone.
  guess: (text) => guessLanguage(text),
  secrets: (text) => scanSecrets(text, 'redact', { fileKind: 'yaml' }),
  values: (text) => valuePositions(text, { fileKind: 'yaml' }),
  rawOnly: (text) => isRawOnly(text, [text.slice(0, 200), '**/*' + text.slice(0, 50)]),
  restore: (text) => restore(text, { __VAR__1: 'customerTotal' }),
  // A map somebody else made, as JSON: the reader's check, then a restore with it.
  map: (text) => restore('__VAR__1 and __VAR__2', parseSymbolMap(JSON.parse(text))),
} satisfies Record<string, Scanner>

const BEGIN = '-----BEGIN PRIVATE' + ' KEY-----\n'

const ROWS: [
  name: string,
  scanner: keyof typeof SCANNERS,
  n: number,
  text: (n: number) => string,
][] = [
  // Quotes, comments and triple quotes that never close.
  ['unclosed double quotes', 'typescript', 500, (n) => '"a\n'.repeat(n)],
  ['unclosed single quotes on one line', 'typescript', 300, (n) => "'a ".repeat(n)],
  ['unclosed backticks', 'typescript', 500, (n) => '`a\n'.repeat(n)],
  ['unclosed block comments', 'typescript', 500, (n) => '/* a\n'.repeat(n)],
  ['block comment openers on one line', 'typescript', 4000, (n) => '/*'.repeat(n)],
  ['unclosed triple quotes', 'python', 500, (n) => '"""a\n'.repeat(n)],
  ['triple quotes on one line', 'python', 300, (n) => '"""'.repeat(n)],
  ['unclosed quotes in a shell script', 'shell', 400, (n) => 'echo "a\n'.repeat(n)],
  ['unclosed quotes in pasted text', 'pasted', 400, (n) => 'say "a\n'.repeat(n)],
  // Long runs of one character.
  ['slashes', 'typescript', 8000, (n) => '/'.repeat(n)],
  ['slashes, pasted', 'pasted', 8000, (n) => '/'.repeat(n)],
  ['newlines', 'typescript', 2000, (n) => '\n'.repeat(n)],
  ['newlines, guessed', 'guess', 20000, (n) => '\n'.repeat(n)],
  ['spaces', 'typescript', 8000, (n) => ' '.repeat(n)],
  ['spaces in YAML', 'yaml', 2000, (n) => ' '.repeat(n)],
  ['backslashes', 'typescript', 8000, (n) => '\\'.repeat(n)],
  ['backslashes in a string', 'typescript', 8000, (n) => '"' + '\\'.repeat(n)],
  ['backslashes in a shell script', 'shell', 8000, (n) => '\\'.repeat(n)],
  ['one long word', 'pasted', 8000, (n) => 'a'.repeat(n)],
  ['dashes', 'yaml', 8000, (n) => '-'.repeat(n)],
  ['a path of one character', 'rawOnly', 1500, (n) => 'a/'.repeat(n)],
  ['a path of stars', 'rawOnly', 2000, (n) => '*'.repeat(n)],
  ['placeholders to restore', 'restore', 4000, (n) => '__VAR__1 '.repeat(n)],
  ['underscores to restore', 'restore', 8000, (n) => '_'.repeat(n)],
  [
    'a map of long values, checked and restored with',
    'map',
    400,
    (n) =>
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`__VAR__${i + 1}`, 'a'.repeat(2000) + i])
        )
      ),
  ],
  // Many credential lines, each with a value that never closes.
  ['unclosed credential values in YAML', 'yaml', 200, (n) => 'password: "a1\n'.repeat(n)],
  ['the same under keys with a space', 'yaml', 400, (n) => 'my password: "a1\n'.repeat(n)],
  [
    'the same, quotes alternating',
    'yaml',
    400,
    (n) => `my token: "a1\nmy token: 'b2\n`.repeat(n / 2),
  ],
  ['one unclosed value, then lines', 'values', 4000, (n) => 'my token: "a1\n' + 'zz\n'.repeat(n)],
  [
    'unclosed values, lines between',
    'values',
    4000,
    (n) => ('my token: "a1\n' + 'zz\n'.repeat(9)).repeat(n / 10),
  ],
  ['unclosed credential values in an env file', 'env', 200, (n) => 'DB_PASSWORD="a1\n'.repeat(n)],
  [
    'unclosed credential values in code',
    'typescript',
    400,
    (n) => 'const password = "a1\n'.repeat(n),
  ],
  [
    'block scalars one in another',
    'values',
    2000,
    (n) => Array.from({ length: n }, (_, i) => ' '.repeat(i % 60) + 'token: |\n').join(''),
  ],
  ['one long block scalar', 'values', 4000, (n) => 'token: |\n' + '  a1b2c3\n'.repeat(n)],
  [
    'literals joined over line breaks',
    'typescript',
    800,
    (n) => 'const secret = "a1"' + ' +\n  "b2"'.repeat(n) + '\n',
  ],
  [
    'literals first on their lines',
    'typescript',
    400,
    (n) => 'const secret =\n  "a1" +\n'.repeat(n),
  ],
  ['a plain scalar that carries on', 'values', 4000, (n) => 'token: a1\n' + '  b2c3\n'.repeat(n)],
  [
    'plain scalars that start below their keys',
    'values',
    2000,
    (n) => 'token:\n  a1\n  b2\n'.repeat(n),
  ],
  ['plain scalars one after another', 'values', 2000, (n) => 'token: a1\n  b2\n'.repeat(n)],
  ['an INI value that carries on', 'ini', 1000, (n) => 'token = a1\\\n' + '  b2\\\n'.repeat(n)],
  ['INI values that each carry on', 'ini', 1000, (n) => 'token = a1\\\n'.repeat(n)],
  ['words piped to nothing', 'secrets', 4000, (n) => 'echo a1 | '.repeat(n)],
  ['one echo and a long pipe', 'secrets', 8000, (n) => 'echo a1 |' + ' a'.repeat(n)],
  // Key material and Secret manifests.
  ['a key block that never ends', 'secrets', 8000, (n) => BEGIN + 'QUJD\n'.repeat(n)],
  ['key block openers', 'secrets', 2000, (n) => BEGIN.repeat(n)],
  [
    'a Secret with unclosed values',
    'secrets',
    4000,
    (n) => 'kind: Secret\ndata:\n' + '  a: "\n'.repeat(n),
  ],
  ['Secret documents', 'secrets', 4000, (n) => 'kind: Secret\n---\n'.repeat(n)],
  ['adjacent literals', 'secrets', 8000, (n) => '"ab" + '.repeat(n) + '"c"\n'],
  // The credential patterns: a prefix repeated, a body that never ends as
  // the format does, a flag with no value.
  ['a provider prefix repeated', 'secrets', 8000, (n) => ('github' + '_pat_').repeat(n)],
  ['a token body that never ends', 'secrets', 8000, (n) => 'sntrys' + '_' + 'A'.repeat(n)],
  ['a prefix and dashes', 'secrets', 4000, (n) => ('ya' + '29.' + '-'.repeat(15)).repeat(n)],
  [
    'quoted tokens on one line',
    'secrets',
    4000,
    (n) => 'token ' + ('"' + 'aB3'.repeat(9) + '" ').repeat(n),
  ],
  ['password flags', 'secrets', 8000, (n) => '-p '.repeat(n)],
  ['login commands with no password', 'secrets', 4000, (n) => 'docker login -u a\n'.repeat(n)],
  ['a login command and a long line', 'secrets', 8000, (n) => 'docker login ' + '-u a '.repeat(n)],
  ['global options without end', 'secrets', 8000, (n) => 'docker' + ' --a b'.repeat(n)],
  ['vault login and its options', 'secrets', 8000, (n) => 'vault login' + ' -a=b'.repeat(n)],
  ['htpasswd and its flags', 'secrets', 8000, (n) => 'htpasswd' + ' -a'.repeat(n)],
  ['htpasswd and its words', 'secrets', 8000, (n) => 'htpasswd -b' + ' a'.repeat(n)],
  ['header names', 'secrets', 8000, (n) => 'Authorization: '.repeat(n)],
  ['a header and a long scheme word', 'secrets', 8000, (n) => 'Authorization: ' + 'a'.repeat(n)],
  ['names with letters outside A-Z', 'values', 1500, (n) => 'hasło '.repeat(n)],
  ['one such name without end', 'values', 8000, (n) => 'ł'.repeat(n)],
]

/** The best of `runs` timings of one scan, in milliseconds. */
function best(scan: Scanner, text: string, runs: number): number {
  let least = Infinity
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    scan(text)
    least = Math.min(least, performance.now() - t)
  }
  return least
}

describe('every scanner reads hostile text in linear time', () => {
  // Tried again when a row fails: the suite's other files run beside this one,
  // and growth that is real fails every time.
  it.each(ROWS)('%s (%s)', { retry: 3 }, (_, scanner, n, text) => {
    const scan = SCANNERS[scanner] as Scanner
    const [small, large] = [text(n), text(2 * n)]
    scan(small)
    // Twice the text. A busy machine is measured again, twice at most, before
    // a row is read as growth: quadratic work is four times on every attempt.
    // Under a millisecond is noise.
    const growth = (runs: number): number =>
      Math.max(best(scan, large, runs), 1) / Math.max(best(scan, small, runs), 1)
    let ratio = growth(5)
    for (let again = 0; again < 2 && ratio > 2.5; again++) ratio = Math.min(ratio, growth(15))
    expect(ratio).toBeLessThanOrEqual(2.5)
  })
})
