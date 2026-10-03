// What the developer reads: the band above the prompt and the /veilio reply
// (spec 033, contracts/mod.md).
import type { Guard } from './guard.ts'

export const COVERAGE_LINK =
  'https://github.com/veilio-inc/veilio/blob/main/plugins/veilio-guard/COVERAGE.md'

export function bandText(g: Guard): string {
  if (g.state === 'off')
    return 'Veilio guard OFF for this project: Claude reads raw code. /veilio on'
  if (g.state === 'stopped')
    return `Veilio guard stopped: ${g.stoppedReason}. Every tool call is refused.`
  const names = Object.keys(g.map).length
  return `Veilio guard on · ${names} name${names === 1 ? '' : 's'} in the map · ${g.counts.withheld} withheld · ${g.counts.denied} refused`
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
    '/veilio off   switch it off for this project (Claude then reads raw code)',
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
