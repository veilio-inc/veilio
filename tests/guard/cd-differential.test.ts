import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CORPUS } from './fixtures/cd-corpus.ts'
import { replay, type Verdict } from './fixtures/cd-project.ts'

// Spec 086 T006 (research R7, SC-002): the branch over the corpus against
// main's verdicts (scripts/cd-differential.mts, run once on b48b16d).
// - A refusal where main ran is a regression, unless the entry is on the
//   attack list; those are the snapshot, for review.
// - A run where main refused breaks 078's floor.
// - restoreRefusal, splitChain and shellWords are exactly main's (FR-004).
// The refusal text is not compared: 086 words new reasons, and a placeholder's
// number depends on what was masked before it.
// Spec 091 addendum 2: refusals where main ran, each listed with its rule
// (strings-addendum-2 "Newly refused" #2). Anything else is a regression.
// Addendum 4: the one listed entry, `bench:701:2` (a `sed -i 's/.*/.../'`
// whose `.*` was judged as a shell wildcard), runs again - a sed script is
// in sed's own language (contract §9) - and is off the list, which is empty.
const LISTED: Readonly<Record<string, string>> = {}
const BASE: Verdict[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/cd-differential.base.json'), 'utf8')
)

test('the cd differential: no new refusal off the attack list, the floor kept, the readers unchanged', async () => {
  expect(BASE.map((v) => v.id)).toEqual(CORPUS.map((e) => e.id))
  const now = await replay(CORPUS, () => [])
  const newly: string[] = []
  const floor: string[] = []
  const readers: string[] = []
  const accepted: string[] = []
  const listed: string[] = []
  CORPUS.forEach((e, i) => {
    const [was, is] = [BASE[i]!, now[i]!]
    const show = `${e.id} ${JSON.stringify(e.command)}`
    if (was.deny === null && is.deny !== null) {
      if (e.id in LISTED) listed.push(e.id)
      else (e.source === 'attack' ? accepted : newly).push(`${show} -> ${is.deny}`)
    }
    if (was.deny !== null && is.deny === null) floor.push(`${show} ran; main refused: ${was.deny}`)
    for (const k of ['restore', 'chain', 'words'] as const)
      if (JSON.stringify(was[k]) !== JSON.stringify(is[k]))
        readers.push(`${show} ${k}: ${JSON.stringify(was[k])} -> ${JSON.stringify(is[k])}`)
  })
  expect(newly).toEqual([])
  // A listed entry that runs again is taken off the list.
  expect(listed).toEqual(Object.keys(LISTED))
  expect(floor).toEqual([])
  expect(readers).toEqual([])
  expect(accepted).toMatchSnapshot()
}, 300_000)
