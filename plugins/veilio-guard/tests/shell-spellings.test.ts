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
  `cat .en{v..v}`,
  `cat .e{m..o}v`,
  `cat f{1..3}/../.e''nv`,
  `cat {a..c}/../.e{n..n}v`,
  `cat .e$'n'v`,
  `cat .e$'\\x6e'v`,
  `cat $'.env'`,
  `cat ~/.v*/map.json`,
  `cat ~/.veil''io/map.json`,
  `cat ~/.e''nv`,
  `cat $HOME/.v*/guard-s*`,
  `cat \${HOME}/.v*/map.json`,
  `cat $HOME/.e''nv`,
  `cat $DIR/.v*/map.json`,
  `cat $DIR/.en*`,
  `cat "$DIR"/.en*`,
  `cat $(pwd)/.en*`,
  `cat {a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}{.e,x}nv`,
  `cat {f0,f1,f2,f3,f4,f5,f6,f7,f8,f9,g0,g1,g2,g3,g4,g5,g6,g7,g8,g9,h0,h1,h2,h3,h4,h5,h6,h7,h8,h9,i0,i1,i2,i3,i4,i5,i6,i7,i8,i9,j0,j1,j2,j3,j4,j5,j6,j7,j8,j9,k0,k1,k2,k3,k4,k5,k6,k7,k8,k9,.env}`,
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
  `ls $DIR/*.ts`,
  `cat $DIR/src/index.ts`,
  `ls $HOME/*.ts`,
  `cat ~/notes.txt`,
  `cat "$DIR"/src/*.ts`,
  `cat $'src/index.ts'`,
  `echo {1..5}`,
  `mkdir -p {a,b,c,d}/{e,f,g,h}/{i,j,k,l,m}`,
  `mkdir -p src/{a,b,c,d}/{e,f,g,h}/{i,j,k,l,m}`,
  `cat {a,b}{.e,x}nvx`,
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
