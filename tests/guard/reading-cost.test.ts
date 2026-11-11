import { expect, test } from 'vitest'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
import { globMayBeRawOnly } from '../../plugins/veilio-guard/lib/paths.ts'
import {
  MAX_COMMAND,
  MAX_STEPS,
  parseShell,
  Unreadable,
} from '../../plugins/veilio-guard/lib/shell.ts'
import { CORPUS } from './fixtures/cd-corpus.ts'
import { COST, COST_A3, LONG_ORDINARY, MENTIONS, ORDINARY } from './fixtures/reading-corpora.ts'
import { guardAt, memoryFixture, verdict } from './fixtures/reading-shell.ts'

// Spec 091 addendum 2, rule R9 (contract A13): the reader has a budget of its
// own. Every hostile input of the review returns a verdict - none throws out
// of beforeTool - and a command over 100,000 characters is refused as one
// Veilio cannot read. The budget is a count of steps, so the verdict is the
// same on every machine; the clock here only catches a missing budget.
const LIMIT_MS = 1000
const UNREADABLE = 'as a shell command, so it cannot tell whether it names a file'

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

// Addendum 3 (contract §8.1, A13 (2)): the budget prices what takes time.
// Long plain text - a here-document written to a file, a commit message, many
// plain paths - is ordinary and runs; what replaces the parser's price per
// word as the bound is refused or answered in time.
for (const { name, make } of COST_A3)
  test(`a verdict within the budget: ${name}`, async () => {
    const guard = await guardAt(memoryFixture(), ['secrets/**'])
    const started = performance.now()
    const v = await verdict(guard, make())
    expect(performance.now() - started).toBeLessThan(LIMIT_MS)
    expect(v.verdict).toBe('refused')
    expect(v.text).toContain(UNREADABLE)
  })

for (const { name, make } of LONG_ORDINARY)
  test(`long plain text runs: ${name}`, async () => {
    const command = make()
    expect(command.length).toBeLessThanOrEqual(MAX_COMMAND)
    const guard = await guardAt(memoryFixture(), ['secrets/**'])
    const started = performance.now()
    const v = await verdict(guard, command)
    expect(v.text).toBe(null)
    expect(performance.now() - started).toBeLessThan(LIMIT_MS)
  })

test('the cost table: steps and time for every hostile and every long ordinary row', async () => {
  const rows: string[] = []
  for (const [kind, list] of [
    ['hostile', [...COST, ...COST_A3]],
    ['ordinary', LONG_ORDINARY],
  ] as const)
    for (const { name, make } of list) {
      const command = make()
      const guard = await guardAt(memoryFixture(), ['secrets/**'])
      const started = performance.now()
      const v = await verdict(guard, command)
      const ms = performance.now() - started
      rows.push(
        `${kind.padEnd(9)}${name.slice(0, 62).padEnd(64)}${String(command.length).padStart(7)} chars  ${v.verdict.padEnd(8)}${String(Math.round(guard.lastSteps)).padStart(7)} steps${ms.toFixed(0).padStart(6)} ms`
      )
    }
  process.stdout.write(`reading cost table (budget ${MAX_STEPS} steps)\n${rows.join('\n')}\n`)
  expect(rows.length).toBe(COST.length + COST_A3.length + LONG_ORDINARY.length)
}, 120_000)

test('a command of 100,000 characters is read; one more and it is not', () => {
  expect(MAX_COMMAND).toBe(100_000)
  expect(parseShell(`echo ${'a'.repeat(MAX_COMMAND - 5)}`, 'sh').ok).toBe(true)
  expect(parseShell(`echo ${'a'.repeat(MAX_COMMAND - 4)}`, 'sh')).toEqual({
    ok: false,
    why: 'cost',
  })
  expect(parseShell(`echo ${'a'.repeat(MAX_COMMAND)}`, 'ps')).toEqual({ ok: false, why: 'cost' })
})

test('the reader counts its steps: past the budget a command is unreadable', () => {
  expect(parseShell('echo a b c d e f', 'sh', { n: 0, steps: 10 })).toEqual({
    ok: false,
    why: 'cost',
  })
  expect(parseShell('echo a', 'sh', { n: 0, steps: 100 }).ok).toBe(true)
  // The same count on every machine: 20,000 commands are past it, one is not.
  expect(parseShell(`echo ${'a;'.repeat(20000)}`, 'sh')).toEqual({ ok: false, why: 'cost' })
})

test('the wildcard matcher does not recurse, and counts its steps', () => {
  // 3,000 stars: a stack overflow at 0876180.
  const stars = '*a'.repeat(3000)
  expect(() =>
    globMayBeRawOnly(stars, [], false, { n: 0, steps: Number.MAX_SAFE_INTEGER })
  ).not.toThrow()
  expect(() => globMayBeRawOnly(stars, [], false, { n: 0, steps: 1000 })).toThrow(Unreadable)
  const cost = { n: 0, steps: 1000 }
  expect(globMayBeRawOnly('.en*', [], false, cost)).toBe(true)
  expect(cost.steps).toBeLessThan(1000)
})

test('no ordinary command comes near the budget: under a tenth of it', async () => {
  const guard = await guardAt(memoryFixture(), ['secrets/**'])
  let most = { steps: 0, command: '' }
  for (const command of [...ORDINARY, ...MENTIONS, ...new Set(CORPUS.map((e) => e.command))]) {
    await verdict(guard, command)
    if (guard.lastSteps > most.steps) most = { steps: guard.lastSteps, command }
  }
  process.stdout.write(
    `reading cost: the costliest corpus command takes ${Math.round(most.steps)} of ${MAX_STEPS} steps: ${JSON.stringify(most.command.slice(0, 100))}\n`
  )
  expect(most.steps).toBeGreaterThan(0)
  expect(most.steps).toBeLessThan(MAX_STEPS / 10)
}, 120_000)

test('anything the reader throws is a refusal, with the text for a command Veilio cannot read', async () => {
  const fixture = memoryFixture()
  const files: Record<string, string> = {
    ...fixture.files,
    [`${fixture.proj}/.veilio/guard.json`]: '{"rawOnly":[]}',
    [`${fixture.proj}/.git/HEAD`]: 'ref: refs/heads/main\n',
  }
  let broken = false
  const io: GuardIO = {
    read: async (p) => {
      if (files[p] === undefined) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    write: async () => {},
    exists: async (p) => p in files || Object.keys(files).some((x) => x.startsWith(`${p}/`)),
    realPath: async (p) => {
      if (broken) throw new Error('the file system gave up')
      return p
    },
    isFile: async (p) => p in files,
    fileSize: async (p) => files[p]?.length,
  }
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(fixture.proj, fixture.home)
  expect((await verdict(guard, 'cat src/index.ts')).verdict).toBe('allowed')
  broken = true
  const v = await verdict(guard, 'cat src/index.ts')
  expect(v.verdict).toBe('refused')
  expect(v.text).toContain(UNREADABLE)
})

test('a refusal of an over-long command shows its start, not all of it', async () => {
  const v = await verdict(await guardAt(memoryFixture(), []), `echo ${'a'.repeat(MAX_COMMAND)}`)
  expect(v.text).toContain(UNREADABLE)
  expect(v.text!.length).toBeLessThan(1000)
})
