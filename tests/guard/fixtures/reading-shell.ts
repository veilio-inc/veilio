// The reading oracle's ground: a throwaway project holding canary files, the
// real shells that run a command in it, and a guard loaded over the same files
// at the same real paths. A canary's token in a shell's output means the file
// was read; the guard's verdict on the same command is compared with that.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Guard, type GuardIO } from '../../../plugins/veilio-guard/lib/guard.ts'

export type Shell = 'bash' | 'zsh'
export type CanaryId = 'ENV' | 'DIR' | 'PEM' | 'KEY' | 'HOME'
export const CANARY_IDS: readonly CanaryId[] = ['ENV', 'DIR', 'PEM', 'KEY', 'HOME']

export type Fixture = {
  tmp: string
  proj: string
  home: string
  /** Each canary's token. */
  tokens: Record<CanaryId, string>
  /** Every file of the fixture: absolute path -> contents. */
  files: Record<string, string>
}

/** The tree of the reading table's §6, in a fresh directory (real path). A
 *  canary file holds its token twice on one line, so reading it as arithmetic
 *  is an error that prints it. */
export function makeFixture(): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-oracle-')))
  const proj = join(tmp, 'proj')
  const home = join(tmp, 'home')
  const tokens = Object.fromEntries(
    CANARY_IDS.map((id) => [id, `VEILIO_CANARY_${id}_${randomBytes(6).toString('hex')}`])
  ) as Record<CanaryId, string>
  const body = (id: CanaryId) => `${tokens[id]} ${tokens[id]}\n`
  const files: Record<string, string> = {
    [join(proj, '.env')]: body('ENV'),
    [join(proj, 'secrets/customers.csv')]: body('DIR'),
    [join(proj, 'server.pem')]: body('PEM'),
    [join(proj, 'id_ed25519')]: body('KEY'),
    [join(proj, '.veilio/guard.json')]: '{"rawOnly":["secrets/**"]}',
    [join(proj, 'src/index.ts')]: 'export {}\n',
    [join(home, '.veilio/map.json')]: body('HOME'),
  }
  const f: Fixture = { tmp, proj, home, tokens, files }
  build(f)
  return f
}

const DIRS = (f: Fixture) => [join(f.proj, 'sub'), join(f.tmp, 't')]

function build(f: Fixture): void {
  for (const d of DIRS(f)) mkdirSync(d, { recursive: true })
  for (const [path, text] of Object.entries(f.files)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
}

export function removeFixture(f: Fixture): void {
  rmSync(f.tmp, { recursive: true, force: true })
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? [`${join(dir, e.name)}/`, ...tree(join(dir, e.name))] : [join(dir, e.name)]
  )

/** Whether the fixture is as it was made (the shell's own temporary files
 *  aside); when not, it is made again. */
export function verifyFixture(f: Fixture): boolean {
  let same = true
  try {
    for (const [path, text] of Object.entries(f.files))
      if (readFileSync(path, 'utf8') !== text) same = false
    const expected = new Set([
      ...Object.keys(f.files),
      ...Object.keys(f.files).flatMap((p) => {
        const out: string[] = []
        for (let d = dirname(p); d.length > f.tmp.length; d = dirname(d)) out.push(`${d}/`)
        return out
      }),
      ...DIRS(f).map((d) => `${d}/`),
    ])
    const scratch = `${join(f.tmp, 't')}/`
    for (const p of tree(f.tmp)) if (!expected.has(p) && !p.startsWith(scratch)) same = false
  } catch {
    same = false
  }
  if (!same) {
    rmSync(f.proj, { recursive: true, force: true })
    rmSync(f.home, { recursive: true, force: true })
    build(f)
  }
  return same
}

const ARGV: Record<Shell, string[]> = {
  bash: ['--noprofile', '--norc', '-c'],
  zsh: ['-f', '-c'],
}
const LIMIT_MS = 5000
const CAP = 64 * 1024

export type Run = { read: Set<CanaryId>; changed: boolean; killed: boolean; output: string }

/** A command run by a real shell in the fixture: exact argv and environment,
 *  stdin closed, killed after 5 s, output cut at 64 KB. `check: false` skips
 *  the fixture comparison (a caller running several at once checks after). */
export function runIn(shell: Shell, command: string, f: Fixture, check = true): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(shell, [...ARGV[shell], command], {
      cwd: f.proj,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: f.home,
        ZDOTDIR: f.home,
        LC_ALL: 'C',
        TMPDIR: join(f.tmp, 't'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a pipeline's programs are killed with it.
      detached: true,
    })
    let output = ''
    let killed = false
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      killed = true
      kill()
    }, LIMIT_MS)
    const take = (chunk: Buffer) => {
      if (output.length < CAP) output += chunk.toString('latin1').slice(0, CAP - output.length)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const done = () => {
      clearTimeout(timer)
      // Anything the command left running is not waited for.
      kill()
      const read = new Set(CANARY_IDS.filter((id) => output.includes(f.tokens[id])))
      resolve({ read, changed: check ? !verifyFixture(f) : false, killed, output })
    }
    child.on('error', done)
    child.on('exit', done)
  })
}

/** The shells present, each with its version. `VEILIO_ORACLE_REQUIRE=bash,zsh`
 *  makes a missing one an error. */
export function shells(): { shell: Shell; version: string }[] {
  const required = (process.env.VEILIO_ORACLE_REQUIRE ?? '').split(',').filter(Boolean)
  const out: { shell: Shell; version: string }[] = []
  for (const shell of ['bash', 'zsh'] as const) {
    const r = spawnSync(shell, ['--version'], { encoding: 'utf8' })
    if (r.status === 0) out.push({ shell, version: (r.stdout.split('\n')[0] ?? '').trim() })
    else if (required.includes(shell))
      throw new Error(`VEILIO_ORACLE_REQUIRE names ${shell}, which is not installed`)
    else process.stdout.write(`reading oracle: ${shell} is not installed; skipped\n`)
  }
  return out
}

/** A guard over an in-memory copy of the fixture's files at the same paths,
 *  with the project's rawOnly list as given. */
export async function guardAt(f: Fixture, rawOnly: readonly string[]): Promise<Guard> {
  const files: Record<string, string> = {
    ...f.files,
    [join(f.proj, '.veilio/guard.json')]: JSON.stringify({ rawOnly }),
    [join(f.proj, '.git/HEAD')]: 'ref: refs/heads/main\n',
  }
  const dirs = new Set(DIRS(f))
  const exists = (p: string) =>
    p in files || dirs.has(p) || Object.keys(files).some((x) => x.startsWith(`${p}/`))
  const io: GuardIO = {
    read: async (p) => {
      const t = files[p]
      if (t === undefined) throw new Error(`ENOENT: ${p}`)
      return t
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => exists(p),
    realPath: async (p) => (exists(p) ? p : undefined),
    isFile: async (p) => p in files,
    fileSize: async (p) => files[p]?.length,
  }
  const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await g.load(f.proj, f.home)
  if (g.state !== 'on') throw new Error(`the oracle's guard is ${g.state}: ${g.stoppedReason}`)
  return g
}

/** The guard's verdict on a Bash command, with the refusal's text. */
export async function verdict(
  guard: Guard,
  command: string
): Promise<{ verdict: 'refused' | 'allowed'; text: string | null }> {
  const v = await guard.beforeTool({ tool: 'Bash', command, description: 'x' })
  return 'deny' in v ? { verdict: 'refused', text: v.deny } : { verdict: 'allowed', text: null }
}

/** The same tree with nothing on disk, at fixed paths: for the corpora, which
 *  are judged and never run (so they run on every platform). */
export function memoryFixture(): Fixture {
  const tmp = '/o'
  const [proj, home] = ['/p', '/home/dev']
  const tokens = Object.fromEntries(
    CANARY_IDS.map((id) => [id, `VEILIO_CANARY_${id}_0`])
  ) as Record<CanaryId, string>
  return {
    tmp,
    proj,
    home,
    tokens,
    files: {
      [`${proj}/.env`]: 'X=1\n',
      [`${proj}/secrets/customers.csv`]: 'x\n',
      [`${proj}/server.pem`]: 'x\n',
      [`${proj}/id_ed25519`]: 'x\n',
      [`${proj}/.veilio/guard.json`]: '{"rawOnly":["secrets/**"]}',
      [`${proj}/src/index.ts`]: 'export {}\n',
      [`${proj}/sub/keep`]: '',
      [`${home}/.veilio/map.json`]: '{}\n',
    },
  }
}
