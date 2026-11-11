import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  CANARIES,
  combinations,
  fullProduct,
  OPERATORS,
  plainName,
  POSITIONS,
  type Generated,
} from './fixtures/reading-grammar.ts'
import {
  guardAt,
  makeFixture,
  removeFixture,
  runIn,
  shells,
  verdict,
  verifyFixture,
  type Fixture,
  type Shell,
} from './fixtures/reading-shell.ts'

// Spec 091, the reading oracle (the reading table's §6). Generated commands
// are run by real bash and zsh in a throwaway project holding canary files; a
// canary's token in the output means the file was read. Compared with the
// guard's verdict on the same command:
//   R1  read by a shell and allowed by the guard: a miss.
//   R2  where the plain name is refused in a position, every spelling a shell
//       proved equal to it is refused there too (also where nothing is run).
//   R5  every operator and position read a canary somewhere, and at least
//       60 % of the commands did: the oracle is not blind.
// Only commands made from the grammar's closed vocabulary are run.
const SEED = Number(process.env.VEILIO_ORACLE_SEED ?? 0x091)
const N = Number(process.env.VEILIO_ORACLE_N ?? 10000)
const AT_ONCE = 8
const TEN_MINUTES = 600_000

type Ran = { shell: Shell; version: string; reads: Map<string, boolean>; ms: number }

describe.skipIf(process.platform === 'win32')('the reading oracle', () => {
  let fixture: Fixture
  let available: { shell: Shell; version: string }[] = []
  let generated: Generated[] = []
  const allowed = new Map<string, boolean>()
  const ran: Ran[] = []
  const changed: string[] = []

  const isAllowed = async (command: string): Promise<boolean> => {
    const known = allowed.get(command)
    if (known !== undefined) return known
    const v = await verdict(await guardAt(fixture, ['secrets/**']), command)
    allowed.set(command, v.verdict === 'allowed')
    return v.verdict === 'allowed'
  }

  /** Commands run eight at a time; the fixture is compared after each eight. */
  const runAll = async (shell: Shell, commands: string[], reads: Map<string, boolean>) => {
    for (let i = 0; i < commands.length; i += AT_ONCE) {
      const batch = commands.slice(i, i + AT_ONCE)
      const out = await Promise.all(batch.map((c) => runIn(shell, c, fixture, false)))
      out.forEach((r, k) => reads.set(batch[k]!, r.read.size > 0))
      if (!verifyFixture(fixture))
        changed.push(...batch.map((c) => `${shell}: ${JSON.stringify(c)}`))
    }
  }

  beforeAll(async () => {
    fixture = makeFixture()
    available = shells()
    generated = [...fullProduct(fixture.proj), ...combinations(N, SEED, fixture.proj)]
    for (const g of generated) await isAllowed(g.command)
    for (const { shell, version } of available) {
      const started = Date.now()
      const reads = new Map<string, boolean>()
      const commands = [
        ...new Set(generated.filter((g) => g.shells.includes(shell)).map((g) => g.command)),
      ]
      await runAll(shell, commands, reads)
      ran.push({ shell, version, reads, ms: Date.now() - started })
    }
  }, TEN_MINUTES)

  afterAll(() => {
    if (fixture) removeFixture(fixture)
  })

  const show = (g: Generated, shell?: { shell: Shell; version: string }) =>
    JSON.stringify({
      ...(shell ? { shell: shell.shell, version: shell.version } : {}),
      command: g.command,
      canary: g.canary,
      id: g.id,
      seed: SEED,
      operators: g.operatorIds.join('+'),
      position: g.positionId,
    })

  test('the oracle can see: a canary read is reported, a plain file is not, a hung command is killed', async () => {
    expect(available.length).toBeGreaterThan(0)
    for (const { shell } of available) {
      const env = await runIn(shell, 'cat .env', fixture)
      expect([...env.read], `${shell}: cat .env`).toEqual(['ENV'])
      const plain = await runIn(shell, 'cat src/index.ts', fixture)
      expect([...plain.read], `${shell}: cat src/index.ts`).toEqual([])
      const started = Date.now()
      // Outside the generator's vocabulary, for this one command: the limit itself.
      const hung = await runIn(shell, 'sleep 30', fixture)
      expect(hung.killed, `${shell}: sleep 30 was killed`).toBe(true)
      expect(Date.now() - started).toBeLessThan(6000)
    }
  }, 30_000)

  test('the generator is deterministic: the same seed gives the same commands', () => {
    const ids = (xs: Generated[]) => xs.map((g) => `${g.id} ${g.command}`)
    expect(ids(combinations(300, SEED, '/x'))).toEqual(ids(combinations(300, SEED, '/x')))
    expect(ids(fullProduct('/x'))).toEqual(ids(fullProduct('/x')))
    expect(combinations(N, SEED, '/x').length).toBe(N)
  })

  test('no command changed the fixture', () => {
    expect(changed).toEqual([])
  })

  test('R1: no command that a shell read a canary with was allowed', () => {
    const misses: string[] = []
    for (const r of ran)
      for (const g of generated)
        if (g.shells.includes(r.shell) && r.reads.get(g.command) && allowed.get(g.command))
          misses.push(show(g, r))
    process.stdout.write(`reading oracle R1: ${misses.length} misses\n`)
    expect(misses).toEqual([])
  })

  test(
    'R2: where the plain name is refused, every spelling a shell proved is refused too',
    async () => {
      const failures: string[] = []
      // The plain name in every position.
      const plainAllowed = new Set<string>()
      for (const c of CANARIES)
        for (const p of POSITIONS) {
          if (p.relative && !c.project) continue
          const plain = p.make(plainName(c))
          if (await isAllowed(plain)) {
            plainAllowed.add(plain)
            failures.push(
              JSON.stringify({ plainNameNotRefused: plain, position: p.id, canary: c.id })
            )
          }
        }
      // Whether a shell read the canary by the spelling alone (position P1).
      const proofs = new Map<string, boolean>()
      const proved = async (g: Generated): Promise<boolean> => {
        const known = proofs.get(g.proof)
        if (known !== undefined) return known
        let read = false
        for (const r of ran) {
          if (!g.proofShells.includes(r.shell)) continue
          if (!r.reads.has(g.proof)) await runAll(r.shell, [g.proof], r.reads)
          read ||= r.reads.get(g.proof) === true
        }
        proofs.set(g.proof, read)
        return read
      }
      for (const g of generated) {
        if (!allowed.get(g.command) || plainAllowed.has(g.plain)) continue
        if (await isAllowed(g.plain)) continue
        if (await proved(g)) failures.push(show(g))
      }
      process.stdout.write(`reading oracle R2: ${failures.length} failures\n`)
      expect(failures).toEqual([])
    },
    TEN_MINUTES
  )

  test('R5: every operator and every executed position read a canary; at least 60 % of commands did', () => {
    const count = () => ({ ran: 0, read: 0 })
    const byOperator = new Map(
      OPERATORS.map((o) => [o.id, new Map(available.map((s) => [s.shell, count()]))])
    )
    const byPosition = new Map(
      POSITIONS.filter((p) => p.executed).map((p) => [
        p.id,
        new Map(available.map((s) => [s.shell, count()])),
      ])
    )
    let executed = 0
    let read = 0
    for (const g of generated) {
      if (g.shells.length === 0) continue
      let any = false
      for (const r of ran) {
        if (!g.shells.includes(r.shell)) continue
        const did = r.reads.get(g.command) === true
        any ||= did
        // An operator is counted alone (the full product), a position always.
        for (const cell of [
          ...(g.operatorIds.length === 1 ? [byOperator.get(g.operatorIds[0]!)] : []),
          byPosition.get(g.positionId),
        ]) {
          const c = cell!.get(r.shell)!
          c.ran++
          if (did) c.read++
        }
      }
      executed++
      if (any) read++
    }
    const lines: string[] = []
    const table = (title: string, rows: Map<string, Map<Shell, { ran: number; read: number }>>) => {
      lines.push(
        `${title.padEnd(10)}${available.map((s) => `${s.shell} read/ran`.padStart(18)).join('')}`
      )
      for (const [id, cells] of rows)
        lines.push(
          `${id.padEnd(10)}${available.map((s) => `${cells.get(s.shell)!.read}/${cells.get(s.shell)!.ran}`.padStart(18)).join('')}`
        )
    }
    table('operator', byOperator)
    table('position', byPosition)
    for (const r of ran)
      lines.push(`${r.shell}: ${r.version}; ${r.reads.size} commands in ${r.ms} ms`)
    lines.push(
      `generated ${generated.length} (seed ${SEED}, ${N} combinations); executed ${executed}; read a canary ${read} (${((100 * read) / Math.max(executed, 1)).toFixed(1)} %)`
    )
    process.stdout.write(`reading oracle R5\n${lines.join('\n')}\n`)
    const dead = [...byOperator, ...byPosition]
      .filter(([, cells]) => [...cells.values()].every((c) => c.read === 0))
      .map(([id]) => id)
    // With one shell missing, what only the other reads cannot be alive.
    if (available.length === 2) expect(dead).toEqual([])
    expect(read / Math.max(executed, 1)).toBeGreaterThanOrEqual(0.6)
  })
})
