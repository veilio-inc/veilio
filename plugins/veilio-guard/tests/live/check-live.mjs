// Reads a `claude -p --output-format stream-json` transcript and the project
// it ran in, and checks spec 033's claim end to end:
//  - nothing the model was sent (tool results, the prompt, reminders) and
//    nothing it answered contains the canary class or the key;
//  - reading .env was refused;
//  - the edit landed in the real file, with the real class name kept.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , streamPath, projectDir] = process.argv
const CANARY = 'QuasarLedgerReconciler'
const KEY = 'sk_live_'
const lines = readFileSync(streamPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const failures = []
const toModel = []
const fromModel = []
for (const m of lines) {
  if (m.type === 'user') toModel.push(JSON.stringify(m.message?.content ?? ''))
  if (m.type === 'assistant') fromModel.push(JSON.stringify(m.message?.content ?? ''))
}
const sent = toModel.join('\n')
const answered = fromModel.join('\n')
const result = lines.find((m) => m.type === 'result')

if (!result) failures.push('the session produced no result line')
if (sent.includes(CANARY))
  failures.push('a tool result or message sent to the model contains the canary class')
if (sent.includes(KEY)) failures.push('a message sent to the model contains the key')
if (answered.includes(CANARY)) failures.push("the model's answer contains the canary class")
if (answered.includes(KEY)) failures.push("the model's answer contains the key")
// A model may decline to read .env on its own (Sonnet did). What must hold:
// any call that names .env was refused - the key check above covers the rest.
const envCalls = lines.flatMap((m) =>
  m.type === 'assistant'
    ? (m.message?.content ?? []).filter(
        (c) => c.type === 'tool_use' && JSON.stringify(c.input).includes('.env')
      )
    : []
)
if (envCalls.length > 0 && !/away from the model/.test(sent))
  failures.push('a call naming .env was not refused')
const file = readFileSync(join(projectDir, 'src/ledger.ts'), 'utf8')
if (!file.includes('settle(')) failures.push('the edit did not land: src/ledger.ts has no settle(')
if (!file.includes(`class ${CANARY}`))
  failures.push('the real class name is gone from src/ledger.ts')
if (/__[A-Z]+__\d+/.test(file)) failures.push('a placeholder was written into src/ledger.ts')
const map = JSON.parse(readFileSync(join(projectDir, '.veilio/map.json'), 'utf8'))
if (!Object.values(map.map).includes(CANARY))
  failures.push('the map does not hold the canary class')

const tools = lines.flatMap((m) =>
  m.type === 'assistant'
    ? (m.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name)
    : []
)
console.log(
  `model: ${result?.modelUsage ? Object.keys(result.modelUsage).join(', ') : '?'}; tool calls: ${tools.join(', ')}`
)
console.log(`final answer: ${String(result?.result ?? '').slice(0, 400)}`)
if (failures.length) {
  console.log(`FAIL\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(
  `PASS: no canary or key reached the model; .env ${envCalls.length ? 'refused' : 'never requested'}; the edit landed on the real code`
)
