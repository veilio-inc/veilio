// Writes baseline-1.19.3.json: what the PUBLISHED engine 1.19.3 answers for
// every row and option set of baseline-corpus.ts. Run once, against the
// registry tarball unpacked outside the repository, never against this
// working tree's build:
//   npm pack @veilio-inc/engine@1.19.3 && tar -xzf veilio-inc-engine-1.19.3.tgz
//   node tests/fixtures/baseline-1.19.3.gen.mjs <unpacked>/package/dist/index.js <dist.shasum>
// The record is not regenerated: a row that may differ from it is listed in
// baseline-exceptions.ts. It also writes baseline-1.19.3.repo.json (below).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { baselineRows, redactionCount, REPOSITORY_LIMIT, veiled } from './baseline-corpus.ts'
import { SYNTAXES, VALUES } from './syntax-corpus.ts'
import { HELD, ROWS } from './manual-marks.ts'

const VERSION = '1.19.3'
const entry = resolve(process.argv[2] ?? '')
const shasum = process.argv[3]
if (!process.argv[2] || !/^[0-9a-f]{40}$/.test(shasum ?? ''))
  throw new Error('usage: baseline-1.19.3.gen.mjs <package>/dist/index.js <dist.shasum>')
const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'))
if (pkg.name !== '@veilio-inc/engine' || pkg.version !== VERSION)
  throw new Error(`this record is of ${VERSION} only - got ${pkg.name}@${pkg.version}`)

const published = await import(pathToFileURL(entry).href)
const { anonymize, restore } = published

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

// No run of eight characters of a planted credential may be left in a row
// (the rows from `format:` on; the older rows plant shorter pieces).
for (const { name, secrets = [] } of baselineRows({
  syntaxes: SYNTAXES,
  values: VALUES,
  marks: ROWS,
  held: HELD,
})) {
  if (!/^(?:format|context|name|lines|login): /.test(name)) continue
  const record = JSON.stringify(rows[name])
  for (const secret of secrets)
    for (let i = 0; i + 8 <= secret.length; i++)
      if (record.includes(secret.slice(i, i + 8)))
        throw new Error(`a piece of a planted credential is left in the record of: ${name}`)
}

const text = JSON.stringify({ engine: { version: VERSION, shasum }, rows }, null, 2) + '\n'
// The record is public: no provider-shaped key and no key body may be in it.
// (The rows of manual-marks.ts hold a key cut by a mark, as their own record does.)
const unmarked = JSON.stringify(
  Object.fromEntries(Object.entries(rows).filter(([name]) => !name.startsWith('mark: ')))
)
const shaped =
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprse]-[A-Za-z0-9-]{10,}|(?:github_pat_|do[opr]_v1_|whsec_|sntry[us]_|lin_api_|hv[sbr]\.|xapp-|AGE-SECRET-KEY-1|HRKU-|ya29\.)[A-Za-z0-9]{10,}|[A-Za-z0-9+/]{48,}/.exec(
    unmarked
  )
if (shaped) throw new Error(`a credential-shaped value is left in the record: ${shaped[0]}`)
writeFileSync(new URL('./baseline-1.19.3.json', import.meta.url), text)

// baseline-1.19.3.repo.json: how many redaction tokens the same package leaves
// in each tracked text file of this repository, with a digest of the file as
// it was, so a file edited since is not held to an old count.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const files = {}
for (const path of execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .sort()) {
  let content
  try {
    content = readFileSync(join(root, path), 'utf8')
  } catch {
    continue
  }
  if (content.length > REPOSITORY_LIMIT || content.includes('\0')) continue
  files[path] = [
    createHash('sha256').update(content).digest('hex').slice(0, 16),
    redactionCount(published, path, content),
  ]
}
writeFileSync(
  new URL('./baseline-1.19.3.repo.json', import.meta.url),
  JSON.stringify({ engine: { version: VERSION, shasum }, files }, null, 1) + '\n'
)
