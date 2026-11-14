// Writes manual-marks-main.json: what a given build of the engine answers for
// the rows of manual-marks.ts (see there). Run with origin/main's build:
//   node tests/fixtures/manual-marks-main.gen.mjs <path to that build>/engine.js
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { HELD, MODES, ROWS } from './manual-marks.ts'

const { anonymize } = await import(pathToFileURL(process.argv[2]).href)
const answer = (code, options) => {
  const { anonymized, map } = anonymize(code, { existingMap: HELD, ...options })
  return { anonymized, map }
}
const out = {}
for (const { name, code, manual, path } of ROWS) {
  out[name] = { unmarked: answer(code, { path }) }
  for (const secrets of MODES) out[name][secrets] = answer(code, { path, manual, secrets })
}
writeFileSync(
  new URL('./manual-marks-main.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n'
)
