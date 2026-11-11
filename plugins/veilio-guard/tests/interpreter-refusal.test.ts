// Security audit 2026-11-11: the interpreter refusal and the brace cap.
import { expect, test } from 'claude-code/testing'
import { project, ROOT } from './helpers.ts'

const HOME = '/home/dev'

// The interpreters that would read or change ~/.veilio under a name they build
// are refused by the code they are given. Defence in depth, not a guarantee:
// the agent's own processes run as the user (SECURITY.md).
for (const command of [
  `python3 -c 'import os;p=os.path.expanduser("~/.vei"+"lio/map.json");open(p,"w").write("{}")'`,
  `python3 -c "print(open('/home/dev/.veilio/credentials').read())"`,
  `node -e "require('fs').writeFileSync(process.env.HOME+'/.veil'+'io/map.json','{}')"`,
  `ruby -e 'File.write(File.expand_path("~/.v"+"eilio/x"), "")'`,
  `perl -e 'open F, ">", $ENV{HOME}."/.vei"."lio/map.json"'`,
  `php -r 'file_put_contents(getenv("HOME")."/.veil"."io/map.json","{}");'`,
  `bash -c 'echo {} > ~/.vei""lio/map.json'`,
  `python3 - <<'EOF'\nimport os\nopen(os.path.expanduser("~/.vei\\\nlio/map.json"),"w").write("{}")\nEOF`,
  `echo hi; python3 -c 'import os; open(os.path.expanduser("~/.vei"+"lio/x"),"w")'`,
  `ls && node -e "require('fs').writeFileSync('.veil'+'io/x','{}')"`,
  `python3 - <<'EOF'\nimport os; p=os.path.expanduser('~/.vei'+'lio/x')\nEOF`,
])
  test(`an interpreter command that names Veilio's files is refused: ${command.slice(0, 40)}`, async ($, on) => {
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
  `git commit -m "fix guard state" && sh -c 'echo hi'`,
  `echo .veilio; python3 -c 'print(1)'`,
  `cat notes/.veilio-x.txt | python3 -c 'import sys; print(len(sys.stdin.read()))'`,
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
