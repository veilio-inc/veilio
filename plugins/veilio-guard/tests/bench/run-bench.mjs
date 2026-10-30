// How much worse does Claude Code do with the guard on? The same bug-fix tasks
// run headless three ways: no guard, the guard on a fresh map, and the guard
// on a map built beforehand with `veilio scrub` (what a project that already
// uses Veilio has). score-bench.mjs then compares pass rate, turns, cost and
// tokens.
//
//   node plugins/veilio-guard/tests/bench/run-bench.mjs [options]
//     --repo <path>     repository to work in (default: this one). A private
//                       repository gives the honest number: on a public one the
//                       model may recall the names the guard hides.
//     --tasks <file>    task list (default: tasks/veilio-oss.json)
//     --model <id>      (default: claude-sonnet-5-5)
//     --reps <n>        sessions per task and arm (default: 3)
//     --arms <list>     (default: plain,guard-cold,guard-warm)
//     --only <ids>      these task ids only, comma-separated
//     --max-turns <n>   (default: 40)
//     --out <dir>       results directory; an existing one is resumed
//     --concurrency <n> sessions started together, one arm per wave
//                       (default: 1, one session at a time)
//     --hours <h>       time box: no wave starts after it (default: none)
//     --team <module>   the team behind the guard-team arm: a module whose
//                       default export signs its members in, hands each
//                       session its map and publishes it after (see
//                       bench-lib.mjs loadTeam). The bench itself knows no
//                       Cloud instance.
//     --validate        check every task's planted bug, run no session
//     --plugin <dir>    the guard to measure (default: this one), such as a
//                       worktree of an earlier release, to compare the two
//     --settings <file> settings every arm's session also loads (Claude
//                       Code's --settings), such as enabledPlugins for
//                       installed plugins: the bench loads none by default
//
// Spends model usage: one session per task, arm and rep. Needs Claude Code
// signed in, and packages/cli built.
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  cpSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { TOOLS, armArgs, callTeam, deadlinePassed, loadTeam, schedule } from './bench-lib.mjs'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { isKeyword } = await import(join(HERE, '../../vendor/engine/index.js'))
// The languages a masked keyword is checked against: those the repository's
// own source is in (set when the warm map is built).
let LANGUAGES = ['typescript']
const { languageOfPath } = await import(join(HERE, '../../vendor/engine/index.js'))
const PLUGIN = resolve(HERE, '../..')
const CLI = resolve(PLUGIN, '../../packages/cli/dist/index.js')
const MCP = resolve(PLUGIN, '../../packages/mcp/dist/index.js')
const ALL_ARMS = ['plain', 'guard-cold', 'guard-warm', 'guard-team', 'mcp', 'cli']
const DEFAULT_ARMS = ['plain', 'guard-cold', 'guard-warm']

const { values: opt } = parseArgs({
  options: {
    repo: { type: 'string', default: resolve(PLUGIN, '../..') },
    tasks: { type: 'string', default: join(HERE, 'tasks/veilio-oss.json') },
    model: { type: 'string', default: 'claude-sonnet-5-5' },
    reps: { type: 'string', default: '3' },
    arms: { type: 'string', default: DEFAULT_ARMS.join(',') },
    only: { type: 'string' },
    'max-turns': { type: 'string', default: '40' },
    out: { type: 'string' },
    validate: { type: 'boolean', default: false },
    plugin: { type: 'string' },
    settings: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    hours: { type: 'string' },
    team: { type: 'string' },
  },
})
const REPO = resolve(opt.repo)
const GUARD = opt.plugin ? resolve(opt.plugin) : PLUGIN
const SETTINGS = opt.settings ? resolve(opt.settings) : null
const TASKS_FILE = resolve(opt.tasks)
const spec = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
const only = opt.only?.split(',')
const tasks = spec.tasks.filter((t) => !only || only.includes(t.id))
const arms = opt.arms.split(',')
for (const a of arms) if (!ALL_ARMS.includes(a)) throw new Error(`unknown arm: ${a}`)
const REPS = Number(opt.reps)
const MAX_TURNS = Number(opt['max-turns'])
const CONCURRENCY = Math.max(1, Number(opt.concurrency))
const TEAM = await loadTeam(opt.team ? pathToFileURL(resolve(opt.team)).href : null, arms)
const MEMBERS = TEAM ? TEAM.members() : []
// Two sessions of one wave for one member would pull and publish the same map.
if (TEAM && CONCURRENCY > MEMBERS.length)
  throw new Error(`--concurrency ${CONCURRENCY} is more than the team's ${MEMBERS.length} members`)
// The CLI runs signed out, in a HOME of its own. Signed in, every `veilio
// scrub` asks Veilio Cloud for the team's maps and reserves placeholder
// numbers: one request per file, hundreds per run, on whichever account the
// developer is signed in to (a staging account's rate limit was exhausted
// that way). The bench measures the local guard; it never touches Cloud.
// Claude Code itself needs the developer's HOME for its own sign-in, and the
// guard plugin running inside it makes no network request and does not read
// ~/.veilio.
const CLI_HOME = mkdtempSync(join(tmpdir(), 'veilio-bench-home-'))
const CLI_ENV = { ...process.env, HOME: CLI_HOME, USERPROFILE: CLI_HOME }
function refuseSignedIn() {
  if (!existsSync(CLI)) return
  const who = spawnSync('node', [CLI, 'whoami'], { env: CLI_ENV, encoding: 'utf8' })
  if (!/Not signed in/.test(`${who.stdout}${who.stderr}`))
    throw new Error('the CLI the bench runs is signed in to Veilio Cloud: refusing to run')
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|java|kt|cs|rb|php|rs|swift|c|cc|cpp|h|hpp)$/

function sh(cmd, cwd, timeout = 300_000) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function must(cmd, cwd) {
  const r = sh(cmd, cwd)
  if (r.code !== 0) throw new Error(`${cmd} failed:\n${r.out}`)
  return r.out.trim()
}

// Argument arrays, for anything that takes a path: no quoting to get wrong.
function call(file, args, cwd, env = process.env) {
  const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r.stdout
}

// Every temporary clone, so an interrupted run leaves none behind.
const temps = new Set()
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
  temps.delete(dir)
}
temps.add(CLI_HOME)
// The mcp and cli arms call `veilio` by name: a wrapper for this build, with
// the same signed-out HOME, first on their PATH. Claude Code keeps the
// developer's HOME for its own sign-in.
const VEILIO_BIN = mkdtempSync(join(tmpdir(), 'veilio-bench-bin-'))
temps.add(VEILIO_BIN)
writeFileSync(
  join(VEILIO_BIN, 'veilio'),
  `#!/bin/sh\nHOME='${CLI_HOME}' exec node '${CLI}' "$@"\n`,
  { mode: 0o755 }
)
const MCP_SERVER = { command: 'node', args: [MCP], env: { HOME: CLI_HOME, USERPROFILE: CLI_HOME } }
process.on('exit', () => [...temps].forEach(cleanup))
// After the temp HOME is registered, so a refusal still removes it.
refuseSignedIn()
process.on('SIGINT', () => process.exit(130))

// A clone with no history: `git log -p` would show the planted bug, and the
// task list (if it lives in the repository) holds the answer.
function prepare(task, { mutate }) {
  const dir = mkdtempSync(join(tmpdir(), 'veilio-bench-'))
  temps.add(dir)
  const repo = join(dir, 'repo')
  call('git', ['clone', '-q', '--local', REPO, repo])
  for (const own of [HERE, dirname(TASKS_FILE)]) {
    const rel = relative(REPO, own)
    if (!rel.startsWith('..')) rmSync(join(repo, rel), { recursive: true, force: true })
  }
  // Dependencies are linked, not installed: the tests import their source by
  // relative path, so a planted bug lands in the code under test.
  const modules = must(
    `find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*'`,
    REPO
  )
  for (const m of modules.split('\n').filter(Boolean)) {
    if (existsSync(join(repo, dirname(m)))) symlinkSync(join(REPO, m), join(repo, m))
  }
  if (mutate) plant(repo, task)
  rmSync(join(repo, '.git'), { recursive: true, force: true })
  must('git init -q', repo)
  writeFileSync(join(repo, '.git/info/exclude'), 'node_modules\n.veilio/\n')
  must('git add -A && git -c user.email=b@example.com -c user.name=bench commit -qm fixture', repo)
  return { dir, repo }
}

function plant(repo, task) {
  const path = join(repo, task.file)
  const text = readFileSync(path, 'utf8')
  const n = text.split(task.find).length - 1
  if (n !== 1) throw new Error(`${task.id}: "find" occurs ${n} times in ${task.file}, not once`)
  writeFileSync(path, text.replace(task.find, task.replace))
}

function validate() {
  let bad = 0
  for (const task of tasks) {
    const clean = prepare(task, { mutate: false })
    const before = sh(task.test, clean.repo)
    cleanup(clean.dir)
    const planted = prepare(task, { mutate: true })
    const after = sh(task.test, planted.repo)
    cleanup(planted.dir)
    const ok = before.code === 0 && after.code !== 0
    if (!ok) bad++
    console.log(
      `${ok ? 'ok  ' : 'BAD '} ${task.id}: clean ${before.code === 0 ? 'passes' : 'FAILS'}, planted ${after.code === 0 ? 'PASSES' : 'fails'}`
    )
    if (!ok && before.code !== 0) console.log(before.out.slice(-1500))
  }
  return bad === 0
}

// What a project that already uses Veilio has: a map covering its source.
// One file per call: `scrub a.ts b.go` detects one language for all of them,
// and on a mixed repository that masks one language's keywords in the other.
// Built once, on a clean clone: a planted bug adds no name.
let warmMap = null
// Spec 050 FR-011: the project's distinctive own names, from that map - a
// declared kind (variable, function, class), an inner capital or underscore,
// four characters or more. A lowercase word (`total`) is left out: it is
// English as often as a name, and counting it would report prose as leaks.
let reference = new Set()
function buildMap(repo) {
  if (!warmMap) {
    const clean = prepare(tasks[0], { mutate: false })
    const files = call('git', ['ls-files', '-z'], clean.repo)
      .split('\0')
      .filter((f) => SOURCE.test(f))
    for (const f of files) call('node', [CLI, 'scrub', '-q', f], clean.repo, CLI_ENV)
    LANGUAGES = [...new Set(files.map((f) => languageOfPath(f)).filter(Boolean))]
    const map = mkdtempSync(join(tmpdir(), 'veilio-bench-map-'))
    temps.add(map)
    cpSync(join(clean.repo, '.veilio'), map, { recursive: true })
    cleanup(clean.dir)
    warmMap = map
    const entries = Object.entries(readMap(join(map, 'map.json')))
    reference = new Set(
      entries
        .filter(([placeholder]) => /^__(VAR|FN|CLS)__\d+$/.test(placeholder))
        .map(([, name]) => name)
        .filter(
          (n) => n.length >= 4 && /[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]/.test(n) && !/^[A-Z0-9_]+$/.test(n)
        )
    )
  }
  if (repo) cpSync(warmMap, join(repo, '.veilio'), { recursive: true })
}

function readMap(path) {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).map ?? {}) : {}
}

function mapSize(repo) {
  const path = join(repo, '.veilio/map.json')
  if (!existsSync(path)) return 0
  return Object.keys(JSON.parse(readFileSync(path, 'utf8')).map ?? {}).length
}

function text(content) {
  if (typeof content === 'string') return content
  // An MCP result is a list of text blocks: joined as written, so a name at the
  // start of a line is still a whole word to the leak measure.
  if (Array.isArray(content) && content.every((b) => typeof b?.text === 'string'))
    return content.map((b) => b.text).join('\n')
  return JSON.stringify(content ?? '')
}

// A shell call that prints a source file whole, past the arm's own reading
// tool (spec 062 review): counted apart from test output, which every arm sees.
// head/tail/sed/awk count when they start a command (on a file), not when
// they trim piped test output.
const RAW_READ_CALL =
  /\bruby\s+-e\b|\bpython3?\s+-c\b|\bnode\s+-e\b|git\s+diff\s+--no-index|File\.read|open\(.+\)\.read|(?:^|&&|;)\s*(?:head|tail|sed\s+-n|awk)\b/

function readStream(path) {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init') ?? {}
  const result = lines.findLast((l) => l.type === 'result') ?? {}
  const toolCalls = {}
  const toolResults = []
  const rawReadCalls = []
  // Everything the model was sent: tool results and the user's messages.
  const sent = []
  for (const l of lines) {
    if (l.type === 'user' && typeof l.message?.content === 'string') sent.push(l.message.content)
    for (const c of l.message?.content ?? []) {
      if (c.type === 'tool_use') toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1
      if (
        c.type === 'tool_use' &&
        c.name === 'Bash' &&
        RAW_READ_CALL.test(String(c.input?.command ?? ''))
      )
        rawReadCalls.push(String(c.input.command).slice(0, 160))
      if (c.type === 'tool_result') toolResults.push(text(c.content))
      if (l.type === 'user' && c.type === 'text') sent.push(c.text)
    }
  }
  sent.push(...toolResults)
  const u = result.usage ?? {}
  const final = String(result.result ?? '')
  return {
    subtype: result.subtype ?? 'no-result',
    isError: Boolean(result.is_error),
    turns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    costUsd: result.total_cost_usd ?? null,
    inputTokens: u.input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    toolCalls,
    toolCallCount: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    permissionDenials: result.permission_denials?.length ?? 0,
    guardRefused: toolResults.filter((t) => /Veilio refused this call|away from the model/.test(t))
      .length,
    guardWithheld: toolResults.filter((t) => /Veilio withheld this result/.test(t)).length,
    // In `claude -p` the reply is not restored, so a placeholder in it is one
    // the reader would have to look up.
    finalHasPlaceholders: /__[A-Z]+__\d+/.test(final),
    final: final.slice(0, 600),
    sent: sent.join('\n'),
    plugins: (init.plugins ?? []).map((p) => p.name ?? p),
    mcpServers: (init.mcp_servers ?? []).map((s) => s.name ?? s),
    mcpStatus: (init.mcp_servers ?? []).map((s) => `${s.name ?? s}:${s.status ?? '?'}`),
    rawReadCalls,
  }
}

async function session(task, arm, rep, outDir, member) {
  const { dir, repo } = prepare(task, { mutate: true })
  try {
    // The mcp and cli arms work on the same map the warm guard has.
    if (arm === 'guard-warm' || arm === 'mcp' || arm === 'cli') buildMap(repo)
    const a = armArgs(arm, { armPrompts: spec.armPrompts, mcpServer: MCP_SERVER })
    // The team's map, as this member has it: the team module writes it.
    if (arm === 'guard-team') await callTeam(TEAM, 'beforeSession', { member, repo, task, rep })
    const mapBefore = mapSize(repo)
    const prompt = spec.prompt.replaceAll('{test}', task.test)
    const args = [
      '-p',
      prompt,
      '--model',
      opt.model,
      // The runner's own plugins, hooks and MCP servers stay out of every arm.
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      a.allowed,
      '--max-turns',
      String(MAX_TURNS),
      '--output-format',
      'stream-json',
      '--verbose',
    ]
    if (SETTINGS) args.push('--settings', SETTINGS)
    if (a.guard) args.push('--plugin-dir', GUARD)
    if (a.disallowed) args.push('--disallowedTools', a.disallowed)
    if (a.appendPrompt) args.push('--append-system-prompt', a.appendPrompt)
    if (a.mcpConfig) {
      const cfg = join(dir, 'mcp.json')
      writeFileSync(cfg, JSON.stringify(a.mcpConfig))
      args.push('--mcp-config', cfg)
    }
    const base = join(outDir, 'sessions', `${task.id}.${arm}.${rep}`)
    const streamFd = openSync(`${base}.jsonl`, 'w')
    const errFd = openSync(`${base}.err`, 'w')
    const started = Date.now()
    // Async, so the sessions of one wave run side by side.
    const run = await new Promise((done) => {
      const env = a.veilioOnPath
        ? { ...process.env, PATH: `${VEILIO_BIN}:${process.env.PATH}` }
        : process.env
      const child = spawn('claude', args, { cwd: repo, env, stdio: ['ignore', streamFd, errFd] })
      const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000)
      child.on('error', (error) => (clearTimeout(timer), done({ error })))
      // The end is read here, not after: under concurrency a sibling's
      // synchronous work (its test run, its team hooks) can hold the loop.
      child.on('exit', (status) => (clearTimeout(timer), done({ status, endedAt: Date.now() })))
    })
    closeSync(streamFd)
    closeSync(errFd)
    const wallMs = (run.endedAt ?? Date.now()) - started
    const s = readStream(`${base}.jsonl`)
    // A session that never got to work (usage limit, signed out, timed out)
    // says nothing about the guard. It stops the run instead of being scored,
    // and resuming the same --out runs it again.
    if (run.error || s.subtype === 'no-result' || (s.isError && s.subtype !== 'error_max_turns'))
      throw new Error(
        `${task.id} ${arm} #${rep} did not run to an answer (${run.error?.message ?? s.subtype}): see ${base}.err and ${base}.jsonl`
      )

    const test = sh(task.test, repo)
    sh('git add -A -N', repo)
    const diff = sh('git diff', repo).out
    writeFileSync(`${base}.diff`, diff)
    writeFileSync(`${base}.test.log`, test.out)
    const changed = sh('git diff --name-only', repo).out.split('\n').filter(Boolean)
    const testsEdited = changed.filter((f) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(f))
    const placeholdersWritten = [
      ...new Set(
        diff
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .flatMap((l) => l.match(/__[A-Z]+__\d+/g) ?? [])
      ),
    ]
    // FR-011: what of the project reached the model, and which keywords did not.
    const { sent, ...stream } = s
    const tokens = new Set(sent.match(/[A-Za-z_$][\w$]*/g) ?? [])
    const leakedNames = [...reference].filter((n) => tokens.has(n))
    const finalMap = readMap(join(repo, '.veilio/map.json'))
    const maskedKeywords = [
      ...new Set(
        (sent.match(/__[A-Z]+__\d+/g) ?? [])
          .map((p) => finalMap[p])
          // The task's own language when it names one: on a mixed repository the
          // union of every language's keywords counts a TypeScript `match` as a
          // masked Python keyword.
          .filter(
            (n) => n && (task.language ? [task.language] : LANGUAGES).some((l) => isKeyword(n, l))
          )
      ),
    ]
    // A session that stopped to ask for its prompt again, and changed nothing.
    const askedAgain =
      changed.length === 0 &&
      /paste|plain text|send (it|the command) again|which (test|file) you mean/i.test(stream.final)
    const record = {
      task: task.id,
      language: task.language ?? null,
      member: member ?? null,
      arm,
      rep,
      leakedNames,
      maskedKeywords,
      askedAgain,
      passed: test.code === 0 && testsEdited.length === 0 && placeholdersWritten.length === 0,
      testPassed: test.code === 0,
      testsEdited,
      placeholdersWritten,
      filesChanged: changed.length,
      mapBefore,
      mapAfter: mapSize(repo),
      wallMs,
      ...stream,
    }
    // What the team made of it: published or refused, restored or not.
    if (arm === 'guard-team')
      Object.assign(
        record,
        await callTeam(TEAM, 'afterSession', { member, repo, task, rep, record })
      )
    return record
  } finally {
    cleanup(dir)
  }
}

function version(cmd, cwd) {
  const r = sh(cmd, cwd)
  return r.code === 0 ? r.out.trim() : null
}

if (!validate()) {
  console.log('Fix the tasks above before spending any session on them.')
  process.exit(1)
}
if (opt.validate) process.exit(0)
// The reference names (FR-011) come from the warm map, built once, whatever arms run.
if (existsSync(CLI)) buildMap(null)
if (arms.includes('mcp') && !existsSync(MCP))
  throw new Error(`${MCP} is missing: npm run build:packages first`)
// Every arm's arguments, before anything is spent: a task list without an arm's
// workflow text fails here, on a fresh or a resumed run alike.
for (const x of arms) armArgs(x, { armPrompts: spec.armPrompts, mcpServer: MCP_SERVER })
if ((arms.some((x) => ['guard-warm', 'mcp', 'cli'].includes(x)) || TEAM) && !existsSync(CLI))
  throw new Error(`${CLI} is missing: npm run build:packages first`)

const outDir = resolve(
  opt.out ?? join(HERE, 'results', new Date().toISOString().replace(/[:.]/g, '-'))
)
mkdirSync(join(outDir, 'sessions'), { recursive: true })
const resultsPath = join(outDir, 'results.jsonl')
const done = new Set(
  existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .map((r) => `${r.task}.${r.arm}.${r.rep}`)
    : []
)
if (!existsSync(join(outDir, 'meta.json')))
  writeFileSync(
    join(outDir, 'meta.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        model: opt.model,
        claudeCode: version('claude --version'),
        node: process.version,
        plugin: {
          commit: version('git rev-parse HEAD', GUARD),
          dirty: Boolean(version('git status --porcelain -- .', GUARD)),
        },
        settings: SETTINGS ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : null,
        repo: { name: REPO.split('/').pop(), commit: version('git rev-parse HEAD', REPO) },
        tasks: relative(process.cwd(), TASKS_FILE),
        taskIds: tasks.map((t) => t.id),
        arms,
        reps: REPS,
        concurrency: CONCURRENCY,
        hours: opt.hours ? Number(opt.hours) : null,
        team: TEAM
          ? { module: relative(process.cwd(), resolve(opt.team)), members: MEMBERS }
          : null,
        maxTurns: MAX_TURNS,
        tools: TOOLS,
        armTools: Object.fromEntries(
          arms.map((x) => [x, armArgs(x, { armPrompts: spec.armPrompts, mcpServer: MCP_SERVER })])
        ),
        // The warm map was built by a signed-out CLI: no Cloud request.
        cli: 'signed out, own HOME',
      },
      null,
      2
    )
  )

const total = tasks.length * arms.length * REPS
const started = Date.now()
let n = done.size
if (TEAM) {
  // Once, on a clean copy: the members sign in and the team's first map is
  // published from it (a planted bug adds no name).
  const clean = prepare(tasks[0], { mutate: false })
  try {
    await callTeam(TEAM, 'setup', { cleanRepo: clean.repo, cli: CLI, outDir })
  } finally {
    cleanup(clean.dir)
  }
}
const waves = schedule({
  tasks,
  arms,
  reps: REPS,
  concurrency: CONCURRENCY,
  members: MEMBERS.length || 1,
})
let boxed = false
for (const wave of waves) {
  const items = wave.items.filter((i) => !done.has(`${i.task.id}.${wave.arm}.${wave.rep}`))
  if (!items.length) continue
  if (deadlinePassed(started, opt.hours)) {
    boxed = true
    break
  }
  const label = items.map((i) => i.task.id).join(', ')
  console.log(`[${n + 1}-${n + items.length}/${total}] ${wave.arm} #${wave.rep}: ${label}`)
  n += items.length
  const records = []
  // Each session is saved the moment it ends: an interrupted wave keeps the
  // sessions that finished, and a resumed run does not repeat them (a team
  // session has already published by then).
  const settled = await Promise.allSettled(
    items.map((i) =>
      session(
        i.task,
        wave.arm,
        wave.rep,
        outDir,
        wave.arm === 'guard-team' ? MEMBERS[i.member] : undefined
      ).then((r) => {
        records.push(r)
        appendFileSync(resultsPath, `${JSON.stringify(r)}\n`)
        console.log(
          `  ${r.task}${r.member ? ` (${r.member})` : ''}: ${r.passed ? 'pass' : 'FAIL'}  ${r.turns} turns  $${r.costUsd?.toFixed(3)}  ${Math.round(r.wallMs / 1000)}s`
        )
        return r
      })
    )
  )
  if (wave.arm === 'guard-team' && records.length) {
    // A count that could not be taken is written as such, never skipped.
    let w
    try {
      w = await callTeam(TEAM, 'afterWave', { records, rep: wave.rep })
    } catch (error) {
      w = { error: String(error?.message ?? error).slice(0, 300) }
    }
    appendFileSync(
      join(outDir, 'waves.jsonl'),
      `${JSON.stringify({ rep: wave.rep, tasks: records.map((r) => r.task), at: new Date().toISOString(), ...w })}\n`
    )
  }
  // A session that did not run says nothing about the guard: the run stops,
  // and resuming the same --out runs it again. Its wave-mates are kept.
  const failed = settled.find((s) => s.status === 'rejected')
  if (failed) throw failed.reason
}
if (boxed) console.log(`Time box of ${opt.hours} h reached: no further wave started.`)
await callTeam(TEAM, 'teardown', { outDir })

spawnSync('node', [join(HERE, 'score-bench.mjs'), outDir], { stdio: 'inherit' })
