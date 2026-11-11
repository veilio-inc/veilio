import { expect, test } from 'vitest'
import { COST } from './fixtures/reading-corpora.ts'
import { guardAt, memoryFixture, verdict } from './fixtures/reading-shell.ts'

// Spec 091 addendum 2, rule R9 (contract A13): the reader has a budget of its
// own. Every hostile input of the review returns a verdict - none throws out
// of beforeTool - and a command over 100,000 characters is refused as one
// Veilio cannot read. The budget is a count of steps, so the verdict is the
// same on every machine; the clock here only catches a missing budget.
const LIMIT_MS = 1000
const UNREADABLE = 'a command Veilio cannot read'

test('the cost corpus is the 36 inputs of the review and its 3,000-star line', () => {
  expect(COST.length).toBe(37)
  expect(new Set(COST.map((c) => c.name)).size).toBe(37)
})

for (const { name, make } of COST)
  test(`a verdict within the budget: ${name}`, async () => {
    const command = make()
    const guard = await guardAt(memoryFixture(), ['secrets/**'])
    const started = performance.now()
    // Nothing is thrown: a refusal is a verdict.
    const v = await verdict(guard, command)
    expect(performance.now() - started).toBeLessThan(LIMIT_MS)
    if (command.length > 100_000) {
      expect(v.verdict).toBe('refused')
      expect(v.text).toContain(UNREADABLE)
    }
  })
