// Spec 086 T005: the base verdicts of the cd differential, run once on CE
// main (b48b16d) before any change to the guard.
//
//   npx tsx scripts/cd-differential.mts
//
// For every entry of tests/guard/fixtures/cd-corpus.ts, in the fixture
// project of contracts/cd-verdicts.md: beforeTool's refusal, restoreRefusal's
// reason, splitChain and shellWords, and the directories 078's shellDirsOf
// checks the command's words in. Written to
// tests/guard/fixtures/cd-differential.base.json, one entry per line: the run
// of record that tests/guard/cd-differential.test.ts compares the branch with.
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CORPUS } from '../tests/guard/fixtures/cd-corpus.ts'
import { replay } from '../tests/guard/fixtures/cd-project.ts'

const ROOT = resolve(import.meta.dirname, '..')
// shellDirsOf is private and replaced on the branch: read here only, on main.
const verdicts = await replay(CORPUS, (g, c) =>
  (g as unknown as { shellDirsOf(c: string): string[] }).shellDirsOf(c)
)
const out = join(ROOT, 'tests/guard/fixtures/cd-differential.base.json')
writeFileSync(out, `[\n${verdicts.map((v) => JSON.stringify(v)).join(',\n')}\n]\n`)
const refused = verdicts.filter((v) => v.deny !== null).length
console.log(`${verdicts.length} entries, ${refused} refused, written to ${out}`)
