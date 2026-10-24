// Reads the three sessions run-scale.sh recorded and the map the guarded ones
// built. Fails when, on the map's second session, an identifier from the map
// reached the model, a tool error did not fit its schema, or the git log was
// turned into placeholders.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { externalNames, languageOfPath, parseDeclarations } from '../../vendor/engine/index.js'

const dir = process.argv[2]
const map = JSON.parse(readFileSync(`${dir}/map.json`, 'utf8')).map
// What the repository takes from public packages and never declares itself
// (`realpathSync` from node:fs): spec 050 leaves those as written by design.
const repo = join(dir, 'repo')
const files = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
  .split('\0')
  .filter((f) => languageOfPath(f) === 'typescript')
const declared = new Set()
const imported = new Set()
const shape = { baseDirs: [...new Set(files.map((f) => f.split('/')[0]))] }
for (const f of files) {
  const text = readFileSync(join(repo, f), 'utf8')
  for (const n of parseDeclarations(text, 'typescript')) declared.add(n)
  for (const n of externalNames(text, 'typescript', shape)) imported.add(n)
}
const thirdParty = new Set([...imported].filter((n) => !declared.has(n)))
// Names worth hiding: mixed case, long enough to be someone's own.
const names = Object.values(map).filter(
  (n) => n.length >= 6 && /[a-z][A-Z]/.test(n) && !thirdParty.has(n)
)

function session(name) {
  const lines = readFileSync(`${dir}/${name}.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const results = []
  const calls = {}
  for (const l of lines)
    for (const c of l.message?.content ?? []) {
      if (c.type === 'tool_use') calls[c.id] = c.input?.command ?? ''
      if (c.type === 'tool_result')
        results.push({
          command: calls[c.tool_use_id] ?? '',
          text: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
        })
    }
  const result = lines.find((l) => l.type === 'result') ?? {}
  const sent = results.map((r) => r.text).join('\n')
  const reached = names.filter((n) => new RegExp(`\\b${n}\\b`).test(sent))
  return { results, sent, reached, ms: result.duration_ms }
}

const failures = []
const report = {}
for (const name of ['plain', 'guard-cold', 'guard-warm']) {
  const s = session(name)
  report[name] = `${s.reached.length}/${names.length} names reached the model, ${s.ms} ms`
  if (name === 'guard-warm') {
    if (s.reached.length > 0)
      failures.push(
        `second session: ${s.reached.length} names reached the model (${s.reached.slice(0, 10).join(', ')})`
      )
    const log = s.results.find((r) => r.command.startsWith('git log'))
    // A capitalised string-literal word (`TypeScript`) or one shaped like a
    // name (`apiV2`) is masked everywhere by design; a lowercase one never is.
    const everyday = [...new Set(log?.text.match(/__STR__\d+/g) ?? [])]
      .map((p) => map[p])
      .filter((w) => /^[a-z]+$/.test(w ?? ''))
    if (everyday.length)
      failures.push(`second session: everyday words masked in the git log (${everyday.join(', ')})`)
    if (!log)
      report.note = 'the second session did not run git log, so its readability was not checked'
  }
  if (name !== 'plain' && /does not match its output shape/.test(s.sent))
    failures.push(`${name}: a tool result did not fit its schema`)
}
console.log(report)
if (failures.length) {
  console.log(`FAIL: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(
  `PASS: on the second session no identifier from the map (${names.length}) reached the model, and every tool result fit its schema`
)
