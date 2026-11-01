// Spec 064: what the guard returns keeps ordinary words as written - in a
// traceback, a path, a test runner's report, Claude Code's own messages - and
// still masks the project's distinctive names. In spec 062 the guard masked
// `recent` inside "Traceback (most recent call last)" and every package
// segment of a Java path, and the model listed the whole tree to find its way.
import { expect, test } from 'claude-code/testing'
import { eventOf, mapFile, project, recordedRaw, ROOT } from './helpers.ts'

const MAP = mapFile({
  __VAR__1: 'recent',
  __VAR__2: 'ledger',
  __VAR__3: 'tarnwick',
  __CLS__4: 'SkerryTariff',
  __VAR__5: 'java',
})

const OUTPUT = [
  'Traceback (most recent call last):',
  '  File "ledger/src/main/java/com/tarnwick/ledger/SkerryTariff.java", line 3',
  'AssertionError: expected SkerryTariff',
].join('\n')

test('ordinary words in tool output stay as written, and distinctive names are masked', async ($, on) => {
  const bash = recordedRaw('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: MAP })
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({ ...r, result: { ...r.result, stdout: OUTPUT } }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).toContain('most recent call last')
  expect(out).toContain('ledger/src/main/java/com/')
  expect(out).not.toContain('tarnwick')
  expect(out).not.toContain('SkerryTariff')
  expect(out).toContain('__CLS__4')
})

test('a codename a custom rule masks stays masked though it is an ordinary word (security review)', async ($, on) => {
  const bash = recordedRaw('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __CODENAME__1: 'phoenix', __VAR__2: 'ledger' }),
  })
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({
    ...r,
    result: { ...r.result, stdout: 'deploying phoenix from ledger/main' },
  }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('phoenix')
  expect(out).toContain('__CODENAME__1')
  expect(out).toContain('ledger/main')
})

test('a credential that is an ordinary word an older map holds is redacted, not shown (code review)', async ($, on) => {
  const bash = recordedRaw('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __VAR__9: 'sunshine' }) })
  const r = bash.r as { result: Record<string, unknown> }
  // A possible credential (client_secret: "sunshine"): the guard writes the
  // map's entry over it, as before. A weak password the scanner does not flag
  // at all (PASSWORD=sunshine) is the documented limit in COVERAGE.md.
  on('tool.call', () => ({ ...r, result: { ...r.result, stdout: 'client_secret: "sunshine"' } }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('sunshine')
})
