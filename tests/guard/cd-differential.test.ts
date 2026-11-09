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
  CORPUS.forEach((e, i) => {
    const [was, is] = [BASE[i]!, now[i]!]
    const show = `${e.id} ${JSON.stringify(e.command)}`
    if (was.deny === null && is.deny !== null)
      (e.source === 'attack' ? accepted : newly).push(`${show} -> ${is.deny}`)
    if (was.deny !== null && is.deny === null) floor.push(`${show} ran; main refused: ${was.deny}`)
    for (const k of ['restore', 'chain', 'words'] as const)
      if (JSON.stringify(was[k]) !== JSON.stringify(is[k]))
        readers.push(`${show} ${k}: ${JSON.stringify(was[k])} -> ${JSON.stringify(is[k])}`)
  })
  expect(newly).toEqual([])
  expect(floor).toEqual([])
  expect(readers).toEqual([])
  expect(accepted).toMatchSnapshot()
}, 300_000)
