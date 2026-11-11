// What the developer reads: the band above the prompt and the /veilio reply
// (spec 033, contracts/mod.md).
import type { Guard } from './guard.ts'
import { numbersLeft } from '../vendor/engine/index.js'

export const COVERAGE_LINK =
  'https://github.com/veilio-inc/veilio/blob/main/plugins/veilio-guard/COVERAGE.md'

export function bandText(g: Guard): string {
  if (g.state === 'off')
    return 'Veilio guard OFF until this session ends: Claude reads raw code. /veilio on'
  if (g.state === 'stopped')
    return `Veilio guard stopped: ${g.stoppedReason}. Every tool call is refused.`
  const names = Object.keys(g.map).length
  const index = g.index
  const indexing =
    index?.state === 'indexing'
      ? ` · indexing ${index.indexed.size}/${index.total} files`
      : index?.state === 'unavailable'
        ? ` · index off (${index.reason})`
        : ''
  // Spec 078 FR-011 (strings.md #14): who gets real names, last.
  const restores = g.mcpRestore.length ? ` · real names to: ${g.mcpRestore.join(', ')}` : ''
  // Not in strings.md yet: awaiting the founder's approval.
  const record = g.legacyOffRecord
    ? ' · /veilio off now lasts for one session, so the guard is on'
    : ''
  return `Veilio guard on · ${names} name${names === 1 ? '' : 's'} in the map${indexing}${teamNumbers(g)} · ${customRules(g)} · ${g.counts.withheld} withheld · ${g.counts.denied} refused${record}${restores}`
}

/** Spec 065: whether the account's custom rules apply, and why not - the
 *  short form of the CLI's rules-skipped sentences. */
function customRules(g: Guard): string {
  const { state, rules, skipped } = g.rules
  if (state === 'none-pulled') return 'custom rules: none pulled - run `veilio rules pull`'
  if (state === 'other-account')
    return 'custom rules: none for this account - run `veilio rules pull`'
  const not = [
    [skipped.vaultLocked, 'vault locked'],
    [skipped.teamLocked, 'team key locked'],
    [skipped.unopenable, 'unopenable'],
    [skipped.refused, 'refused'],
    [skipped.teamUnconfirmed, 'team key not confirmed'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, why]) => `${n} ${why}`)
  // RULES_STOPPED_NOTE's opening words: what the band has room for.
  const stopped =
    g.counts.rulesStopped || g.latest?.spent
      ? ' - custom rules stopped matching: too much work'
      : ''
  return `custom rules: ${rules.length}${not.length ? ` (not applied: ${not.join(', ')})` : ''}${stopped}`
}

/** A planted file's text must not put control characters, nor Unicode format
 *  characters such as bidi overrides, into the band (security review,
 *  2026-10-30; code review of spec 066). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, '?')

/** HH:MM on this machine's clock. */
function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Spec 063: what the guard numbers new names from, when a team is involved. */
function teamNumbers(g: Guard): string {
  const r = g.reserved
  if (!r) return ''
  if (!r.ok)
    return ` · .veilio/reserved.json unreadable (${printable(r.reason)}): new names numbered here`
  // Spec 066 R8: for the whole session, ahead of the numbers left - new names
  // go into this checkout's local family until a pull holds a block.
  if (r.refused) {
    const f = r.refused
    const why =
      f.reason === 'server' && f.detail ? `server: ${printable(f.detail).slice(0, 80)}` : f.reason
    return ` · team numbers refused (${why}): new names numbered here${f.nextAt ? `, next block ${hhmm(f.nextAt)}` : ''}`
  }
  const outside = g.counts.outsideReserved
  const left = numbersLeft(g.map, r.blocks)
  if (outside > 0)
    return ` · ${outside} name${outside === 1 ? '' : 's'} outside reserved team numbers (run veilio maps pull)`
  return left > 0
    ? ` · team numbers: ${left} left`
    : ' · no usable team numbers (run veilio maps pull)'
}

/** strings.md #8 (spec 085 L14): the reply to /veilio on while a stop holds. */
export function stillStopped(reason: string): string {
  return `Veilio stays stopped: ${reason}. \`/veilio on\` cannot lift this; fix the cause first.`
}

export function statusText(g: Guard, managed: boolean): string {
  return [
    bandText(g),
    `Project: ${g.root}`,
    `Map: ${g.mapPath} (${Object.keys(g.map).length} entries)`,
    `Set up: ${managed ? "by your organisation's managed settings" : 'by you (personal)'}`,
    '',
    'What Claude reads through this guard: tool results, your prompts, and the reminders and',
    'instruction files Claude Code adds, with known names as placeholders and secrets removed.',
    'What it does not cover, and the test behind each claim: ' + COVERAGE_LINK,
    '',
    '/veilio off   switch it off until this session ends (Claude then reads raw code)',
    '/veilio on    switch it back on',
  ].join('\n')
}

/** Sent to the model once, with the first message's context: what it will see
 *  and how to work with it. It holds no names. */
export const MODEL_NOTE = [
  'Veilio guard is on in this project. Identifiers in files, command output and messages',
  'appear as placeholders such as __CLS__1, __FN__2 or __VAR__3, and credentials as',
  '__REDACTED_...__. Use placeholders exactly as you see them, in edits, commands and',
  "searches: they are turned back into the real names on the user's machine before",
  'anything runs. Do not invent placeholders or change their spelling. If the user names',
  'something you only see as a placeholder, ask, or read the file and match by context.',
  'Some files (.env, keys) are kept from you; ask the user for what you need from them.',
].join('\n')
