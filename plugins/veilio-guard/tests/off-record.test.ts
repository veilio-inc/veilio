// Security audit 2026-11-11, H1: the agent could turn the guard off by writing
// ~/.veilio/guard-state.json through an interpreter. The off record now carries
// a MAC under a per-install secret that only /veilio off writes with, and a
// record without a valid MAC is ignored.
import { expect, test } from 'claude-code/testing'
import { hmacSha256 } from '../lib/guard.ts'
import {
  CANARY,
  eventOf,
  mapFile,
  NONCE,
  offFiles,
  offMac,
  project,
  recorded,
  ROOT,
  SECRET,
} from './helpers.ts'

const HOME = '/home/dev'
const STATE = `${HOME}/.veilio/guard-state.json`
const SECRET_FILE = `${HOME}/.veilio/guard-secret`
const MAP = { [`${ROOT}/.veilio/map.json`]: mapFile({}) }
const record = (entry: Record<string, unknown>) =>
  JSON.stringify({ version: 1, projects: { [ROOT]: entry } })

for (const [name, files] of [
  [
    'no MAC',
    async () => ({
      [SECRET_FILE]: SECRET,
      [STATE]: record({ enabled: false, changedAt: '2026-11-07' }),
    }),
  ],
  [
    'a wrong MAC',
    async () => ({
      [SECRET_FILE]: SECRET,
      [STATE]: record({ enabled: false, changedAt: '2026-11-07', mac: '0'.repeat(64) }),
    }),
  ],
  [
    "a MAC from another install's secret",
    async () => ({
      [SECRET_FILE]: SECRET,
      [STATE]: record({
        enabled: false,
        changedAt: '2026-11-07',
        nonce: NONCE,
        mac: await offMac('cd'.repeat(32), ROOT, '2026-11-07'),
      }),
    }),
  ],
  [
    'a MAC for another project',
    async () => ({
      [SECRET_FILE]: SECRET,
      [STATE]: record({
        enabled: false,
        changedAt: '2026-11-07',
        nonce: NONCE,
        mac: await offMac(SECRET, '/work/other', '2026-11-07'),
      }),
    }),
  ],
  [
    'a MAC for a changed date',
    async () => ({
      [SECRET_FILE]: SECRET,
      [STATE]: record({
        enabled: false,
        changedAt: '2026-11-08',
        nonce: NONCE,
        mac: await offMac(SECRET, ROOT, '2026-11-07'),
      }),
    }),
  ],
  [
    'a record and no secret at all',
    async () => ({
      [STATE]: record({ enabled: false, changedAt: '2026-11-07', mac: 'ab'.repeat(32) }),
    }),
  ],
] as const)
  test(`an off record with ${name} is ignored: the guard stays on and the band says so`, async ($, on) => {
    const read = recorded('Read')
    project(on, { ...MAP, ...(await files()) }, { home: HOME })
    on('tool.call', () => read.r)
    const r = await $.tool.call(eventOf(read))
    expect(JSON.stringify(r)).not.toContain(CANARY)
    const status = await $.command.run({ command: 'veilio', args: '' })
    const band = status.text.split('\n')[0]
    expect(band).toMatch(/^Veilio guard on/)
    expect(band).toContain('was not made by /veilio off and was ignored')
  })

test('an off record /veilio off made is honoured when the guard loads, with no warning', async ($, on) => {
  const read = recorded('Read')
  project(on, { ...MAP, ...(await offFiles(HOME)) }, { home: HOME })
  on('tool.call', () => read.r)
  const r = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).toContain(CANARY)
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text.split('\n')[0]).toMatch(/^Veilio guard OFF/)
  expect(status.text.split('\n')[0]).not.toContain('ignored')
})

test('/veilio off writes the MAC a later load checks, under a 0600 secret the guard made', async ($, on) => {
  const p = project(on, MAP, { home: HOME })
  expect(p.files[SECRET_FILE]).toBeUndefined()
  await $.command.run({ command: 'veilio', args: 'off' })
  const secret = p.files[SECRET_FILE]!
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  expect(p.modes[SECRET_FILE]).toBe(0o600)
  const entry = JSON.parse(p.files[STATE]!).projects[ROOT]
  expect(entry.enabled).toBe(false)
  expect(entry.mac).toBe(await offMac(secret, ROOT, entry.changedAt, entry.nonce))
  // The secret is not in the record, and a different one is made per install.
  expect(p.files[STATE]).not.toContain(secret)
})

test('the secret is made when the guard first loads, so a record cannot be signed before then', async ($, on) => {
  const p = project(on, MAP, { home: HOME })
  await $.command.run({ command: 'veilio', args: '' })
  expect(p.files[SECRET_FILE]).toMatch(/^[0-9a-f]{64}$/)
  expect(p.modes[SECRET_FILE]).toBe(0o600)
})

test('a secret that is not 64 hex digits signs nothing: the record is ignored', async ($, on) => {
  const read = recorded('Read')
  const files = await offFiles(HOME, ROOT, 'not a secret')
  project(on, { ...MAP, ...files }, { home: HOME })
  on('tool.call', () => read.r)
  const r = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).not.toContain(CANARY)
})

// The agent cannot read ~/.veilio, and the interpreters that would write it
// are refused by what their text names. Defence in depth, not a guarantee: the
// agent's own processes run as the user (SECURITY.md).
for (const command of [
  `python3 -c 'import os;p=os.path.expanduser("~/.vei"+"lio/guard-state.json");open(p,"w").write("{}")'`,
  `python3 -c "open('/home/dev/.veilio/guard-secret','w').write('x')"`,
  `node -e "require('fs').writeFileSync(process.env.HOME+'/.veil'+'io/guard-state.json','{}')"`,
  `node --eval 'require("fs").writeFileSync("guard-"+"state.json","{}")'`,
  `ruby -e 'File.write(File.expand_path("~/.v"+"eilio/x"), "")'`,
  `perl -e 'open F, ">", $ENV{HOME}."/.vei"."lio/guard-state.json"'`,
  `php -r 'file_put_contents(getenv("HOME")."/.veil"."io/guard-state.json","{}");'`,
  `bash -c 'echo {} > ~/.vei""lio/guard-state.json'`,
  `python3 - <<'EOF'\nimport os\nopen(os.path.expanduser("~/.vei\\\nlio/guard-state.json"),"w").write("{}")\nEOF`,
  `python3 -c 'p="".join(["~/.v","e","ilio/guard-state.json"])'`,
])
  test(`an interpreter command that names the guard's files is refused: ${command.slice(0, 40)}`, async ($, on) => {
    project(on, {}, { home: HOME })
    let ran = false
    on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(out.deny).toBeDefined()
    expect(ran).toBe(false)
  })

for (const command of [
  `python3 -c 'print(1+1)'`,
  `node -e "console.log(process.version)"`,
  `python3 script.py`,
  `echo veilio`,
  `python3 -c 'print(open("/work/veilio-app/a.txt").read())'`,
  `node -e "console.log(require('@veilio-inc/engine'))"`,
  `ls src`,
])
  test(`an ordinary interpreter command still runs: ${command}`, async ($, on) => {
    project(on, {}, { home: HOME })
    let ran = false
    on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
    await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(ran).toBe(true)
  })

// The host's crypto.subtle has digest and no importKey, so the guard builds
// HMAC on digest: checked against RFC 4231.
test('the guard’s HMAC-SHA-256 matches RFC 4231, and the MAC format is fixed', async () => {
  const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))
  const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
  const text = (s: string) => new TextEncoder().encode(s)
  // RFC 4231 test cases 1, 2 and 6 (a key longer than the block).
  expect(hex(await hmacSha256(bytes('0b'.repeat(20)), text('Hi There')))).toBe(
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  )
  expect(hex(await hmacSha256(text('Jefe'), text('what do ya want for nothing?')))).toBe(
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  )
  expect(
    hex(
      await hmacSha256(
        bytes('aa'.repeat(131)),
        text('Test Using Larger Than Block-Size Key - Hash Key First')
      )
    )
  ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  // The record's format, fixed: computed with Python's hmac, not with the guard.
  expect(await offMac(SECRET, ROOT, '2026-11-07')).toBe(
    '748cb625b9aec8906710b9628a2b9cf6c50c6342d86458e8c9f0274af99117e9'
  )
})

test('a record whose nonce was changed is ignored', async ($, on) => {
  const read = recorded('Read')
  const files = await offFiles(HOME)
  const rec = JSON.parse(files[STATE]!)
  rec.projects[ROOT].nonce = '11'.repeat(8)
  project(on, { ...MAP, ...files, [STATE]: JSON.stringify(rec) }, { home: HOME })
  on('tool.call', () => read.r)
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
})

test('/veilio off makes a new nonce each time', async ($, on) => {
  const p = project(on, MAP, { home: HOME })
  await $.command.run({ command: 'veilio', args: 'off' })
  const first = JSON.parse(p.files[STATE]!).projects[ROOT].nonce
  expect(first).toMatch(/^[0-9a-f]{16,}$/)
  await $.command.run({ command: 'veilio', args: 'off' })
  expect(JSON.parse(p.files[STATE]!).projects[ROOT].nonce).not.toBe(first)
})

test('/veilio on rotates the secret: an earlier record, replayed, no longer verifies', async ($, on) => {
  const other = '/work/other'
  const files = await offFiles(HOME)
  const mine = JSON.parse(files[STATE]!).projects[ROOT]
  const theirs = await offFiles(HOME, other)
  const record = {
    version: 1,
    projects: { [ROOT]: mine, [other]: JSON.parse(theirs[STATE]!).projects[other] },
  }
  const p = project(
    on,
    { ...MAP, [SECRET_FILE]: SECRET, [STATE]: JSON.stringify(record) },
    { home: HOME }
  )
  await $.command.run({ command: 'veilio', args: 'on' })
  const secret = p.files[SECRET_FILE]!
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  expect(secret).not.toBe(SECRET)
  expect(p.modes[SECRET_FILE]).toBe(0o600)
  const after = JSON.parse(p.files[STATE]!).projects
  expect(after[ROOT]).toBeUndefined()
  // Replaying the old entry: its MAC is under the old secret.
  expect(mine.mac).not.toBe(await offMac(secret, ROOT, mine.changedAt, mine.nonce))
  // Another project's off record is kept, signed again under the new secret.
  expect(after[other].mac).toBe(
    await offMac(secret, other, after[other].changedAt, after[other].nonce)
  )
  expect(after[other].mac).not.toBe(theirs[STATE] && record.projects[other].mac)
})

test('a record signed with the secret from before /veilio on is rejected', async ($, on) => {
  const read = recorded('Read')
  // The files of a machine whose secret was rotated: the record is the old one.
  const files = await offFiles(HOME)
  project(on, { ...MAP, ...files, [SECRET_FILE]: 'cd'.repeat(32) }, { home: HOME })
  on('tool.call', () => read.r)
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
  const band = (await $.command.run({ command: 'veilio', args: '' })).text.split('\n')[0]
  expect(band).toContain('was not made by /veilio off')
})

// The brace cap fails closed: more alternatives than Veilio expands is refused,
// not read as one unexpanded word.
test('a brace word over the cap that holds .env is refused, a small one runs', async ($, on) => {
  project(on, { [`${ROOT}/.env`]: 'X=1\n' })
  let ran = 0
  on('tool.call', () => (ran++, { result: { stdout: '', stderr: '' } }))
  const many = Array.from({ length: 80 }, (_, i) => `f${i}`).join(',')
  const big = await $.tool.call({ tool: 'Bash', command: `cat {${many},.env}`, description: 'x' })
  expect(big.deny).toContain('away from the model')
  const nested = await $.tool.call({
    tool: 'Bash',
    command: `cat {a,b}{c,d}{e,f}{g,h}{i,j}{k,l,m}{.e,x}nv`,
    description: 'x',
  })
  expect(nested.deny).toContain('away from the model')
  expect(ran).toBe(0)
  const small = await $.tool.call({
    tool: 'Bash',
    command: 'cat {src/a,src/b}.ts',
    description: 'x',
  })
  expect(small.deny).toBeUndefined()
  expect(ran).toBe(1)
})
