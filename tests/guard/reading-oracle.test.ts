import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Guard } from '../../plugins/veilio-guard/lib/guard.ts'
import {
  bashIs,
  bracketRuns,
  CANARIES,
  CLUSTERS,
  combinations,
  continuedDelimiters,
  dataQualifiers,
  deliveries,
  FOLDER_POSITIONS,
  FOLDERS,
  folders,
  fullProduct,
  groupScripts,
  OPERANDS,
  ordinaryShapes,
  ownLanguage,
  plainName,
  POSITIONS,
  searches,
  searchTwins,
  settingForms,
  shHasPipefail,
  sinks,
  triggers,
  unknownOptions,
  type Generated,
  type Listed,
  type Ordinary,
} from './fixtures/reading-grammar.ts'
import {
  hookGuard,
  hookVerdict,
  makeFixture,
  removeFixture,
  runIn,
  shells,
  verifyFixture,
  type Fixture,
  type Locale,
  type Shell,
} from './fixtures/reading-shell.ts'

// Spec 091, the reading oracle (the reading table's §6). Generated commands
// are run by real bash and zsh in a throwaway project holding canary files; a
// canary's token in the output means the file was read. Compared with the
// guard's verdict on the same command:
//   R1  read by a shell and allowed by the guard: a miss.
//   R2  where the plain name is refused in a position, every spelling a shell
//       proved equal to it is refused there too (also where nothing is run).
//   R5  every operator, position and axis value read a canary in each shell
//       it is run in: the oracle is not blind, in neither shell.
//   R7  the guard is called as the hook calls it: over the real files, the
//       host's directory first.
//   R8  what could fail is counted apart from what a rule refuses unrun.
//   R11 the ordinary shapes the grammar generates are allowed, and a shell
//       running them reads no canary and lists the file they were made for.
// Only commands made from the grammar's closed vocabulary are run.
const SEED = Number(process.env.VEILIO_ORACLE_SEED ?? 0x091)
const N = Number(process.env.VEILIO_ORACLE_N ?? 10000)
/** Seeded deliveries after the pairs (contract §7.8). */
const DELIVERIES = Number(process.env.VEILIO_ORACLE_DELIVERIES ?? Math.ceil(N / 3))
const AT_ONCE = 8
// A hosted Linux runner needs over ten minutes for the whole grammar (530 s before addendum 3).
const TIME_LIMIT = 1_800_000

type Ran = { shell: Shell; version: string; reads: Map<string, boolean>; ms: number }

describe.skipIf(process.platform === 'win32')('the reading oracle', () => {
  let fixture: Fixture
  let available: { shell: Shell; version: string }[] = []
  let generated: Generated[] = []
  let guard: Guard
  let listed: Listed = { shopt: [], set: [], setopt: [], modules: [] }
  let ordinary: Ordinary[] = []
  const allowed = new Map<string, boolean>()
  const ran: Ran[] = []
  const changed: string[] = []

  const isAllowed = async (command: string): Promise<boolean> => {
    const known = allowed.get(command)
    if (known !== undefined) return known
    const v = await hookVerdict(guard, command, fixture.proj)
    allowed.set(command, v.verdict === 'allowed')
    return v.verdict === 'allowed'
  }

  /** Commands run eight at a time; the fixture is compared after each eight.
   *  A command is read when it reads under any locale it is run in. */
  const runAll = async (
    shell: Shell,
    commands: string[],
    reads: Map<string, boolean>,
    locale: Locale = 'C'
  ) => {
    for (let i = 0; i < commands.length; i += AT_ONCE) {
      const batch = commands.slice(i, i + AT_ONCE)
      const out = await Promise.all(batch.map((c) => runIn(shell, c, fixture, false, locale)))
      out.forEach((r, k) => reads.set(batch[k]!, reads.get(batch[k]!) === true || r.read.size > 0))
      if (!verifyFixture(fixture))
        changed.push(...batch.map((c) => `${shell}: ${JSON.stringify(c)}`))
    }
  }

  /** The lines a shell prints for a command of the oracle's own (not a generated one). */
  const ask = (shell: Shell, script: string): string[] =>
    (
      spawnSync(shell, [shell === 'zsh' ? '-fc' : '-c', script], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      }).stdout ?? ''
    )
      .split('\n')
      .filter(Boolean)
  /** The option and module names the running shells list themselves (O39). */
  const listShells = (): Listed => {
    const has = (sh: Shell) => available.some((a) => a.shell === sh)
    const first = (lines: string[]) => lines.map((l) => l.trim().split(/\s+/)[0]!)
    return {
      shopt: has('bash') ? ask('bash', 'shopt -p').map((l) => l.split(' ')[2]!) : [],
      set: has('bash') ? first(ask('bash', 'set -o')) : [],
      setopt: has('zsh')
        ? first(ask('zsh', 'emulate -lLR zsh; setopt ksh_option_print; setopt'))
        : [],
      // Every module file under zsh's module path (`zsh/mapfile` is `zsh/mapfile.so`).
      modules: has('zsh')
        ? [
            ...new Set(
              ask('zsh', 'for f in $module_path/**/*(.N); print ${${f#$module_path/}:r}').filter(
                Boolean
              )
            ),
          ]
        : [],
    }
  }

  beforeAll(async () => {
    fixture = makeFixture()
    available = shells()
    bashIs(
      Number(
        /version (\d+)/.exec(available.find((a) => a.shell === 'bash')?.version ?? '')?.[1] ?? 3
      )
    )
    listed = listShells()
    // `sh` is dash on Debian and Ubuntu: no `pipefail` there (position P61).
    shHasPipefail(
      spawnSync('sh', ['-oc', 'pipefail', 'true'], { env: { PATH: '/usr/bin:/bin' } }).status === 0
    )
    guard = await hookGuard(fixture, ['secrets/**'])
    generated = [
      ...fullProduct(fixture.proj),
      ...combinations(N, SEED, fixture.proj),
      ...folders(fixture.proj),
      ...deliveries(SEED, DELIVERIES),
      ...triggers(listed),
      // Addendum 3 (contract §8.3): G3-G9.
      ...searches(),
      ...unknownOptions(),
      ...sinks(),
      ...dataQualifiers(),
      ...groupScripts(),
      ...continuedDelimiters(),
      ...settingForms(),
      ...bracketRuns(),
      // Addendum 4 (contract §9): G12.
      ...ownLanguage(),
    ]
    ordinary = [...ordinaryShapes(), ...searchTwins()]
    for (const g of generated) await isAllowed(g.command)
    for (const { shell, version } of available) {
      const started = Date.now()
      const reads = new Map<string, boolean>()
      const mine = generated.filter((g) => g.shells.includes(shell))
      await runAll(shell, [...new Set(mine.map((g) => g.command))], reads)
      const collating = mine.filter((g) => g.locales.includes('en_US.UTF-8'))
      await runAll(shell, [...new Set(collating.map((g) => g.command))], reads, 'en_US.UTF-8')
      ran.push({ shell, version, reads, ms: Date.now() - started })
    }
  }, TIME_LIMIT)

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
      ...(g.positionId === 'delivery' || g.positionId === 'trigger' || /^G\d/.test(g.positionId)
        ? { values: g.values }
        : {}),
    })

  test('the oracle can see: a canary read is reported, a plain file is not, a hung command is killed', async () => {
    expect(available.length).toBeGreaterThan(0)
    for (const { shell } of available) {
      const env = await runIn(shell, 'cat .env', fixture)
      expect([...env.read], `${shell}: cat .env`).toEqual(['ENV'])
      const plain = await runIn(shell, 'cat src/index.ts', fixture)
      expect([...plain.read], `${shell}: cat src/index.ts`).toEqual([])
      // A match a program colours is still a read: the escape codes that
      // split the token are taken out first.
      const coloured = await runIn(shell, 'grep --color=always CANARY .env', fixture)
      expect(coloured.output, `${shell}: grep --color=always`).toContain('\x1b[')
      expect([...coloured.read], `${shell}: grep --color=always CANARY .env`).toEqual(['ENV'])
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
    expect(ids(deliveries(SEED, 200))).toEqual(ids(deliveries(SEED, 200)))
    expect(combinations(N, SEED, '/x').length).toBe(N)
  })

  test('no command changed the fixture', () => {
    expect(changed).toEqual([])
  })

  test('R1: no command that a shell read a canary with was allowed', () => {
    const misses: string[] = []
    for (const r of ran)
      for (const g of generated)
        if (
          !g.carried &&
          g.shells.includes(r.shell) &&
          r.reads.get(g.command) &&
          allowed.get(g.command)
        )
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
        for (const p of [...POSITIONS, ...(c.id === 'ENV' ? [...CLUSTERS, ...OPERANDS] : [])]) {
          if (p.relative && !c.project) continue
          const plain = p.make(plainName(c))
          if (await isAllowed(plain)) {
            plainAllowed.add(plain)
            failures.push(
              JSON.stringify({ plainNameNotRefused: plain, position: p.id, canary: c.id })
            )
          }
        }
      for (const c of FOLDERS)
        for (const p of FOLDER_POSITIONS) {
          const plain = p.make(plainName(c))
          if (await isAllowed(plain)) {
            plainAllowed.add(plain)
            failures.push(JSON.stringify({ plainNameNotRefused: plain, position: p.id }))
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
        if (g.carried || !allowed.get(g.command) || plainAllowed.has(g.plain)) continue
        if (await isAllowed(g.plain)) continue
        if (await proved(g)) failures.push(show(g))
      }
      process.stdout.write(`reading oracle R2: ${failures.length} failures\n`)
      expect(failures).toEqual([])
    },
    TIME_LIMIT
  )

  test('R5: every operator, position and axis value read a canary in each shell it is run in', () => {
    // A value is run in a shell when a command that shows it is; it is alive
    // there when one of them read a canary there.
    const cells = new Map<string, Map<Shell, { ran: number; read: number }>>()
    for (const g of generated)
      for (const r of ran) {
        if (!g.shells.includes(r.shell)) continue
        const did = r.reads.get(g.command) === true
        for (const value of g.values) {
          const row = cells.get(value) ?? new Map<Shell, { ran: number; read: number }>()
          cells.set(value, row)
          const c = row.get(r.shell) ?? { ran: 0, read: 0 }
          row.set(r.shell, c)
          c.ran++
          if (did) c.read++
        }
      }
    const lines = [
      `${'value'.padEnd(34)}${ran.map((r) => `${r.shell} read/ran`.padStart(18)).join('')}`,
    ]
    const dead: string[] = []
    for (const [value, row] of cells) {
      lines.push(
        `${value.padEnd(34)}${ran.map((r) => (row.has(r.shell) ? `${row.get(r.shell)!.read}/${row.get(r.shell)!.ran}` : '-').padStart(18)).join('')}`
      )
      for (const [shell, c] of row) if (c.read === 0) dead.push(`${value} in ${shell}`)
    }
    process.stdout.write(`reading oracle R5\n${lines.join('\n')}\n`)
    expect(dead).toEqual([])
  })

  test(
    'R11: every ordinary shape is allowed, reads no canary and lists the file it was made for',
    async () => {
      const failures: string[] = []
      for (const o of ordinary) {
        const v = await hookVerdict(guard, o.command, fixture.proj)
        const shown = JSON.stringify(
          o.command.length > 200 ? `${o.command.slice(0, 200)}…` : o.command
        )
        if (v.verdict !== 'allowed') failures.push(`refused: ${shown}`)
        for (const { shell } of available) {
          if (!o.shells.includes(shell)) continue
          const r = await runIn(shell, o.command, fixture)
          if (r.read.size > 0) failures.push(`${shell} read ${[...r.read].join(',')}: ${shown}`)
          if (r.changed) failures.push(`${shell} changed the fixture: ${shown}`)
          if (o.prints !== null && !r.output.includes(o.prints))
            failures.push(`${shell} did not list ${o.prints}: ${shown}`)
        }
      }
      process.stdout.write(
        `reading oracle R11: ${ordinary.length} ordinary shapes, ${failures.length} failures\n`
      )
      expect(ordinary.length).toBeGreaterThan(200)
      expect(failures).toEqual([])
    },
    TIME_LIMIT
  )

  test('R8: what could fail is counted apart from what is refused unrun', () => {
    let unrun = 0
    let executed = 0
    let couldFail = 0
    let outside = 0
    let misses = 0
    for (const g of generated) {
      if (g.shells.length === 0) {
        unrun++
        continue
      }
      executed++
      const read = ran.some((r) => g.shells.includes(r.shell) && r.reads.get(g.command) === true)
      if (g.carried) outside++
      else if (read) {
        couldFail++
        if (allowed.get(g.command)) misses++
      }
    }
    const lines = [
      // R10: where this ran.
      `platform ${process.platform} ${process.arch}; locales C and en_US.UTF-8 (LC_ALL of the caller: ${process.env.LC_ALL ?? process.env.LANG ?? 'unset'})`,
      ...ran.map((r) => `${r.shell}: ${r.version}; ${r.reads.size} commands in ${r.ms} ms`),
      `listed by the shells: ${listed.shopt.length} shopt names, ${listed.set.length} set -o names, ${listed.setopt.length} zsh options, ${listed.modules.length} zsh modules`,
      `generated ${generated.length} (seed ${SEED}, ${N} combinations, ${DELIVERIES} deliveries after the pairs)`,
      `judged only, never executed ${unrun}`,
      `executed ${executed}`,
      `outside the promise (a variable carries part of the name) ${outside}`,
      `could fail (executed and read a canary in at least one shell) ${couldFail}`,
      `misses ${misses}`,
    ]
    process.stdout.write(`reading oracle R8\n${lines.join('\n')}\n`)
    expect(couldFail).toBeGreaterThanOrEqual(20000)
    expect(couldFail).toBeGreaterThanOrEqual(executed / 2)
  })
})
