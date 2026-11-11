// The reading oracle's ground: a throwaway project holding canary files, the
// real shells that run a command in it, and a guard loaded over the same files
// at the same real paths. A canary's token in a shell's output means the file
// was read; the guard's verdict on the same command is compared with that.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
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
  /** Paths that lead elsewhere, as a symbolic link does (in memory only). */
  links?: Record<string, string>
  /** Symbolic links on disk: absolute path -> target (`mysh`, a shell under
   *  a name that is not a shell's). */
  onDisk?: Record<string, string>
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
    [join(proj, 'a.txt')]: 'a\n',
    // Not raw-only by its name; zsh's `(:r)` takes its suffix off.
    [join(proj, 'server.pem.bak')]: 'a copy that is not a key\n',
    [join(home, '.veilio/map.json')]: body('HOME'),
  }
  const onDisk = { [join(proj, 'mysh')]: '/bin/sh' }
  const f: Fixture = { tmp, proj, home, tokens, files, onDisk }
  build(f)
  return f
}

// `sub` is also the name a zsh qualifier rewrites (`sub(:s/sub/.env/)`).
const DIRS = (f: Fixture) => [join(f.proj, 'sub'), join(f.tmp, 't')]

function build(f: Fixture): void {
  for (const d of DIRS(f)) mkdirSync(d, { recursive: true })
  for (const [path, text] of Object.entries(f.files)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  for (const [path, target] of Object.entries(f.onDisk ?? {})) symlinkSync(target, path)
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
      ...Object.keys(f.onDisk ?? {}),
    ])
    for (const [path, target] of Object.entries(f.onDisk ?? {}))
      if (readlinkSync(path) !== target) same = false
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

/** Terminal escape sequences: `ESC [ ... letter` and `ESC ] ... BEL`. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

export type Run = { read: Set<CanaryId>; changed: boolean; killed: boolean; output: string }
export type Locale = 'C' | 'en_US.UTF-8'

/** A command run by a real shell in the fixture: exact argv and environment,
 *  stdin closed, killed after 5 s, output cut at 64 KB. `check: false` skips
 *  the fixture comparison (a caller running several at once checks after).
 *  `locale`: a real session runs under the user's, where a range collates. */
export function runIn(
  shell: Shell,
  command: string,
  f: Fixture,
  check = true,
  locale: Locale = 'C'
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(shell, [...ARGV[shell], command], {
      cwd: f.proj,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: f.home,
        ZDOTDIR: f.home,
        LC_ALL: locale,
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
      // A program that colours its matches splits the token with escape
      // sequences (`grep --color`): they are taken out before it is looked for.
      const seen = output.replace(ESCAPES, '')
      const read = new Set(CANARY_IDS.filter((id) => seen.includes(f.tokens[id])))
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
  const links = f.links ?? {}
  const exists = (p: string) =>
    p in files || p in links || dirs.has(p) || Object.keys(files).some((x) => x.startsWith(`${p}/`))
  const io: GuardIO = {
    read: async (p) => {
      const t = files[p]
      if (t === undefined) throw new Error(`ENOENT: ${p}`)
      return t
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => exists(p),
    // As a file system does: `.` and `..` resolved before the link is followed.
    realPath: async (path) => {
      const p = posix.normalize(path)
      return links[p] ?? (exists(p) ? p : undefined)
    },
    isFile: async (p) => (links[p] ?? p) in files,
    fileSize: async (p) => files[links[p] ?? p]?.length,
  }
  const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await g.load(f.proj, f.home)
  if (g.state !== 'on') throw new Error(`the oracle's guard is ${g.state}: ${g.stoppedReason}`)
  return g
}

/** A guard over the fixture's real files, as the hook builds it (rule R6):
 *  `read`, `exists`, `realPath`, `isLink`, `isFile` and `fileSize` from the
 *  file system, the project's list and its `.git/HEAD` as `guardAt` gives them. */
export async function hookGuard(f: Fixture, rawOnly: readonly string[]): Promise<Guard> {
  const config = join(f.proj, '.veilio/guard.json')
  const head = join(f.proj, '.git/HEAD')
  const io: GuardIO = {
    read: async (p) =>
      p === config
        ? JSON.stringify({ rawOnly })
        : p === head
          ? 'ref: refs/heads/main\n'
          : readFileSync(p, 'utf8'),
    write: async () => {},
    exists: async (p) => p === head || existsSync(p),
    realPath: async (p) => {
      try {
        return realpathSync(p)
      } catch {
        return undefined
      }
    },
    isLink: async (p) => {
      try {
        return lstatSync(p).isSymbolicLink()
      } catch {
        return false
      }
    },
    isFile: async (p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    },
    fileSize: async (p) => {
      try {
        return statSync(p).size
      } catch {
        return undefined
      }
    },
  }
  const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await g.load(f.proj, f.home)
  if (g.state !== 'on') throw new Error(`the oracle's guard is ${g.state}: ${g.stoppedReason}`)
  return g
}

/** The verdict as the hook gets it (plugins/veilio-guard/hooks/register.ts,
 *  `tool.call`): where the host says the shell is, then the call (rule R7). */
export async function hookVerdict(
  guard: Guard,
  command: string,
  cwd: string
): Promise<{ verdict: 'refused' | 'allowed'; text: string | null }> {
  guard.atHost(cwd)
  return verdict(guard, command)
}

/** The guard's verdict on a Bash command, with the refusal's text. */
export async function verdict(
  guard: Guard,
  command: string,
  tool: 'Bash' | 'PowerShell' = 'Bash'
): Promise<{ verdict: 'refused' | 'allowed'; text: string | null }> {
  const v = await guard.beforeTool({ tool, command, description: 'x' })
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
    // In the session's directory `latest` leads to .env; in src/ there is none.
    links: { [`${proj}/latest`]: `${proj}/.env` },
  }
}
