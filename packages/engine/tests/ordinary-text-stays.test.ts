import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import { COMMIT_ID, INTEGRITY, ORDINARY_NAMES, SENTENCE, UUID } from './fixtures/baseline-corpus.js'

// A redaction cannot be restored, so it destroys what it hits. Ordinary names
// and ordinary strings are never redacted one-way: each text below comes out
// with no redaction token and restores exactly. These hold on the published
// 1.19.2 too; every credential rule added since has one of them as the case
// that fails when the rule reaches too far.

const SHELL: AnonymizeOptions = { fileKind: 'shell' }
const TS: AnonymizeOptions = { language: 'typescript' }

const ORDINARY: [name: string, code: string, options: AnonymizeOptions][] = [
  ['a port on docker run', 'docker run -p 8080:80 -d nginx\n', SHELL],
  ['a port on a container named login', 'docker run --name login -p 8080:80 nginx\n', SHELL],
  ['a port on ssh', 'ssh -p 2222 deploy@host.example\n', SHELL],
  ['a port on psql', 'psql -h db -p 5432 -U app shop\n', SHELL],
  [
    'a TypeScript file that names the kind Secret',
    "type Kind = { kind: 'Secret' }\nexport function describeCustomer(customerName: string) {\n  const node = { kind: 'Secret', label: customerName }\n  return node\n}\n",
    TS,
  ],
  ['a commit id', `const commit = "${COMMIT_ID}"\n`, TS],
  ['a commit id on a line that names an author', `const author = pick("${COMMIT_ID}")\n`, TS],
  ['a UUID', `const tenantId = "${UUID}"\n`, TS],
  [
    'a lockfile integrity string',
    `{ "integrity": "${INTEGRITY}" }\n`,
    { path: 'package-lock.json' },
  ],
  ['a long path', 'const fixtures = "packages/engine/tests/fixtures/baseline"\n', TS],
  ...ORDINARY_NAMES.map((name): [string, string, AnonymizeOptions] => [
    `a sentence under the name ${name}`,
    `const ${name} = "${SENTENCE}"\n`,
    TS,
  ]),
]

describe('ordinary text is never redacted one-way', () => {
  it.each(ORDINARY)('%s', (_, code, options) => {
    const { anonymized, map } = anonymize(code, options)
    expect(anonymized).not.toContain('__REDACTED_')
    expect(restore(anonymized, map).restored).toBe(code)
  })
})
