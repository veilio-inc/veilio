// Security audit 2026-11-11, M2: a raw-only file named by a spelling the shell
// reads as the real name (`.e''nv`, `.en*`, `{.e,x}nv`) is refused as the plain
// name is. The word is read as the shell reads it, not as it was typed.
import { expect, test } from 'claude-code/testing'
import { project, ROOT } from './helpers.ts'

const FILES = {
  [`${ROOT}/.env`]: 'X=1\n',
  [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }),
  [`${ROOT}/secrets/customers.csv`]: 'ada@example.test\n',
  [`${ROOT}/src/index.ts`]: 'export {}\n',
}

const REFUSED = [
  `cat .e''nv`,
  `cat .e""nv`,
  `cat .e\\nv`,
  `cat .en?`,
  `cat .en*`,
  `cat .e[n]v`,
  `cat {.e,x}nv`,
  `cat {a,.env}`,
  `cat .veil''io/map.json`,
  `cp .e''nv /tmp/x`,
  `cat sec''rets/customers.csv`,
  `cat sec"re"ts/customers.csv`,
  `cat secrets/*.csv`,
  `cat secr*/customers.csv`,
  `cat /work/project/.e''nv`,
  `cat ./.e''nv`,
  `cat src/../.e''nv`,
  `cat '.e'nv`,
  `head -1 id_r''sa`,
  `cat server.p''em`,
  `cat *.pem`,
  `cat id_*`,
  `cat .*`,
]
for (const command of REFUSED)
  test(`refused: ${command}`, async ($, on) => {
    project(on, FILES)
    let ran = false
    on('tool.call', () => ((ran = true), { result: { stdout: 'X=1', stderr: '' } }))
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(ran, `${command} ran`).toBe(false)
    expect(out.deny).toContain('away from the model')
  })

const ALLOWED = [
  `cat src/index.ts`,
  `ls *.ts`,
  `ls src/*.ts`,
  `ls *`,
  `rm -f *.o`,
  `cat src/in''dex.ts`,
  `cat 'src/index.ts'`,
  `cat {src/index,src/other}.ts`,
  `grep -r foo src/*`,
  `git add -A && git commit -m "x"`,
  `echo "a*b"`,
]
for (const command of ALLOWED)
  test(`still allowed: ${command}`, async ($, on) => {
    project(on, FILES)
    let ran = false
    on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(out.deny, command).toBeUndefined()
    expect(ran).toBe(true)
  })

test('a cd first does not hide the spelling', async ($, on) => {
  project(on, FILES)
  let ran = false
  on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
  const out = await $.tool.call({
    tool: 'Bash',
    command: `cd src && cat ../.e''nv`,
    description: 'x',
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})
