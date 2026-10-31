// The gate for round 3 of the security review (an amendment to spec 064): a
// differential of the engine before 064's readable words against this one.
//
//   git worktree add /tmp/pre064 bd09468^
//   (cd /tmp/pre064/packages/engine && npx tsc --outDir dist-old)
//   npm run build -w packages/engine
//   npx tsx scripts/value-differential.mts /tmp/pre064/packages/engine/dist-old [project dir]
//
// Inputs: every string literal of the engine's secret and credential tests and
// fixtures, read as code and as each config kind; and, given a directory, each
// file in it. Where a text holds values is read by an independent lexer
// (tests/fixtures/value-lexer.ts), not by the engine. A word the old engine
// masked that the new one shows in a value is a leak, and the script exits
// non-zero. One the new engine shows elsewhere is 064's gain, in an identifier
// or a path. The counts go to packages/engine/tests/fixtures/
// value-differential.out.json: the run of record.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { valueRanges, wordCounts } from '../packages/engine/tests/fixtures/value-lexer.ts'

type Engine = typeof import('../packages/engine/src/index.ts')
type Opts = { path?: string }

const ROOT = resolve(import.meta.dirname, '..')
const [oldDir, project] = process.argv.slice(2)
if (!oldDir) throw new Error('usage: value-differential.mts <old engine dist> [project dir]')
const OLD: Engine = await import(join(resolve(oldDir), 'index.js'))
const NEW: Engine = await import(join(ROOT, 'packages/engine/dist/index.js'))

const get = (m: Map<string, number>, w: string) => m.get(w) ?? 0

/** Old and new over one text: leaks, newly readable words, words to keep masked. */
function compare(text: string, opts: Opts) {
  const old = OLD.anonymize(text, opts)
  const neu = NEW.anonymize(text, opts)
  const given = wordCounts(text)
  const before = wordCounts(old.anonymized)
  const after = wordCounts(neu.anonymized)
  // What the old engine masked: its map's names, and words its redaction took.
  const masked = new Set(Object.values(old.map).filter((v) => given.has(v)))
  for (const w of given.keys()) if (!before.has(w)) masked.add(w)
  const values = (t: string) => wordCounts(t, valueRanges(t, opts.path))
  const paths = (t: string) => wordCounts(t, valueRanges(t, opts.path, true))
  const [vOld, vNew, vGiven] = [values(old.anonymized), values(neu.anonymized), values(text)]
  const [pOld, pNew] = [paths(old.anonymized), paths(neu.anonymized)]
  // mustMask: masked by the old engine in a value of the text; checked above.
  const r = { leaks: [] as string[], identifiers: 0, paths: 0, mustMask: [] as string[] }
  for (const w of masked) {
    const leak = get(vNew, w) - get(vOld, w)
    if (leak > 0) r.leaks.push(w)
    else if (get(vGiven, w) > 0 && get(vOld, w) === 0) r.mustMask.push(w)
    const shown = Math.max(0, get(after, w) - get(before, w) - Math.max(0, leak))
    const inPath = Math.min(shown, Math.max(0, get(pNew, w) - get(pOld, w)))
    r.paths += inPath
    r.identifiers += shown - inPath
  }
  return r
}

// (a) The engine's secret and credential corpora: every string literal.
const tests = join(ROOT, 'packages/engine/tests')
const files = [
  ...readdirSync(tests)
    .filter((f) => /^(?:secrets|credential|env-style|map-never|regulated|value-positions)/.test(f))
    .map((f) => join(tests, f)),
  ...readdirSync(join(tests, 'fixtures'))
    .filter((f) => f.endsWith('.ts') && f !== 'value-lexer.ts')
    .map((f) => join(tests, 'fixtures', f)),
]
const literals = new Set<string>()
for (const file of files) {
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      if (node.text.length >= 4 && /[A-Za-z]/.test(node.text)) literals.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true))
}
const KINDS = [undefined, '.env', 'c.yml', 'run.sh', 'app.ini', 'app.xml']
const total = () => ({ inputs: 0, leaks: [] as object[], identifiers: 0, paths: 0 })
const corpus = total()
let masked = 0
for (const text of literals)
  for (const path of KINDS) {
    const r = compare(text, path ? { path } : {})
    corpus.inputs++
    corpus.identifiers += r.identifiers
    corpus.paths += r.paths
    for (const word of r.leaks) corpus.leaks.push({ text, path, word })
    masked += r.mustMask.length
  }

// (b) Every file of a project.
const bench = total()
if (project) {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      if (f === 'node_modules' || f === '.git') return []
      const p = join(dir, f)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })
  for (const file of walk(resolve(project))) {
    const path = relative(resolve(project), file)
    const r = compare(readFileSync(file, 'utf8'), { path })
    bench.inputs++
    bench.identifiers += r.identifiers
    bench.paths += r.paths
    for (const word of r.leaks) bench.leaks.push({ path, word })
  }
}

const report = (t: ReturnType<typeof total>) => ({
  inputs: t.inputs,
  leaks: t.leaks.length,
  newlyReadable: { identifiers: t.identifiers, paths: t.paths },
})
const summary = {
  corpus: { ...report(corpus), maskedInValues: masked },
  ...(project ? { project: { ...report(bench), dir: basename(resolve(project)) } } : {}),
}
console.log(JSON.stringify(summary, null, 2))
for (const l of [...corpus.leaks, ...bench.leaks].slice(0, 40))
  console.log('LEAK', JSON.stringify(l))
writeFileSync(
  join(tests, 'fixtures/value-differential.out.json'),
  JSON.stringify(summary, null, 2) + '\n'
)
if (corpus.leaks.length || bench.leaks.length) process.exit(1)
