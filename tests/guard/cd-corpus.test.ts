import { expect, test } from 'vitest'
import { CORPUS } from './fixtures/cd-corpus.ts'

// Spec 086 T004: the benchmark's commands are of a private repository. The
// Cloud extraction refuses to write one that keeps any of its words; this is
// the CE side: nothing in the fixture looks like a name, an address or a path
// of a real machine. The attack and test lists hold ~/.kube and the like on
// purpose, so only the bench entries are checked.
const bench = CORPUS.filter((e) => e.source === 'bench')
const texts = bench.flatMap((e) => [e.command, ...(e.calls ?? [])])

test('the bench corpus is all there: 3,768 calls from 910 sessions', () => {
  expect(bench).toHaveLength(3768)
  expect(new Set(bench.map((e) => e.session)).size).toBe(910)
})

test('no email, URL, home directory, temp directory or benchmark folder name', () => {
  const found = texts.filter((t) =>
    /@[\w-]+\.[a-z]{2,}|:\/\/|\/Users\/|\/home\/|\/private\/var|\/var\/folders|veilio-bench-(?!X)/i.test(
      t
    )
  )
  expect(found).toEqual([])
})

test('no distinctive identifier: inner capitals or underscores only in placeholders, options and node_modules', () => {
  const left = new Set<string>()
  for (const t of texts) {
    const rest = t
      .replace(/__[A-Z]+__\d+/g, ' ')
      .replace(/(?<=^|[\s(;|&=])--?[A-Za-z][A-Za-z-]*/g, ' ')
    for (const [w] of rest.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu))
      if (/\p{Ll}\p{Lu}|_/u.test(w) && w !== 'node_modules') left.add(w)
  }
  expect([...left]).toEqual([])
})

test('every attack and ordinary form is an entry of its own, and ids are unique', () => {
  const count = (s: string) => CORPUS.filter((e) => e.source === s).length
  expect([count('attack'), count('ordinary')]).toEqual([60, 33])
  expect(new Set(CORPUS.map((e) => e.id)).size).toBe(CORPUS.length)
})
