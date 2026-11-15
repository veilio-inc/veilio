// Writes baseline-1.19.1.json: what the PUBLISHED engine 1.19.1 answers for
// every row and option set of baseline-corpus.ts. Run once, against the
// registry tarball unpacked outside the repository, never against this
// working tree's build:
//   npm pack @veilio-inc/engine@1.19.1 && tar -xzf veilio-inc-engine-1.19.1.tgz
//   node tests/fixtures/baseline-1.19.1.gen.mjs <unpacked>/package/dist/index.js <dist.shasum>
// The record is not regenerated: a row that may differ from it is listed in
// baseline-exceptions.ts.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { baselineRows, veiled } from './baseline-corpus.ts'
import { SYNTAXES, VALUES } from './syntax-corpus.ts'
import { HELD, ROWS } from './manual-marks.ts'

const VERSION = '1.19.1'
const entry = resolve(process.argv[2] ?? '')
const shasum = process.argv[3]
if (!process.argv[2] || !/^[0-9a-f]{40}$/.test(shasum ?? ''))
  throw new Error('usage: baseline-1.19.1.gen.mjs <package>/dist/index.js <dist.shasum>')
const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'))
if (pkg.name !== '@veilio-inc/engine' || pkg.version !== VERSION)
  throw new Error(`this record is of ${VERSION} only - got ${pkg.name}@${pkg.version}`)

const { anonymize, restore } = await import(pathToFileURL(entry).href)

const rows = {}
for (const { name, code, options, secrets } of baselineRows({
  syntaxes: SYNTAXES,
  values: VALUES,
  marks: ROWS,
  held: HELD,
})) {
  if (name in rows) throw new Error(`two rows are named ${name}`)
  rows[name] = options.map((given) => {
    const { anonymized, map, language, languageFallback, comments } = anonymize(code, given)
    const { restored } = restore(anonymized, map)
    return veiled(
      { options: given, anonymized, map, language, languageFallback, comments, restored },
      secrets
    )
  })
}

const text = JSON.stringify({ engine: { version: VERSION, shasum }, rows }, null, 2) + '\n'
// The record is public: no provider-shaped key and no key body may be in it.
// (The rows of manual-marks.ts hold a key cut by a mark, as their own record does.)
const unmarked = JSON.stringify(
  Object.fromEntries(Object.entries(rows).filter(([name]) => !name.startsWith('mark: ')))
)
const shaped =
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprse]-[A-Za-z0-9-]{10,}|[A-Za-z0-9+/]{48,}/.exec(
    unmarked
  )
if (shaped) throw new Error(`a credential-shaped value is left in the record: ${shaped[0]}`)
writeFileSync(new URL('./baseline-1.19.1.json', import.meta.url), text)
