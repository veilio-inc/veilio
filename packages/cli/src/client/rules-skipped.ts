// Custom rules served by Cloud that this machine did not apply (spec 065 R6),
// and the words for them: one sentence per cause, with what fixes it, the same
// from `rules pull`, `scrub` and the MCP server. Imports nothing, so the
// offline `scrub` can print them.

/** Rules served by Cloud that this machine could not apply, by cause. */
export interface RulesSkipped {
  /** Personal rules, with no unexpired personal-maps key on this machine. */
  vaultLocked: number
  /** Team rules whose team has no key on this machine. */
  teamLocked: number
  /** Rules that would not open with the keys held, or were not a rule. */
  unopenable: number
  /** Rules that opened but no tool may apply (engine placeholder, unsafe pattern). */
  refused: number
  /** Team rules that open only under a key whose sender this member has not
   *  confirmed (spec 085 R2-8): held back. Absent in an older cache: 0. */
  teamUnconfirmed: number
}

export const NO_RULES_SKIPPED: RulesSkipped = {
  vaultLocked: 0,
  teamLocked: 0,
  unopenable: 0,
  refused: 0,
  teamUnconfirmed: 0,
}

/**
 * One sentence per cause, each with what fixes it - the same words from
 * `rules pull`, `scrub` and the MCP server. Empty when nothing was skipped.
 * `noun: false` drops "custom rule(s)", for `scrub`'s line that has just
 * named them ("applied 2 custom rules ...; 1 not applied: ...").
 */
export function rulesSkippedSentences(s: RulesSkipped, { noun = true } = {}): string[] {
  const n = (count: number): string =>
    `${count}${noun ? ` custom rule${count === 1 ? '' : 's'}` : ''} not applied`
  const out: string[] = []
  if (s.vaultLocked > 0)
    out.push(
      `${n(s.vaultLocked)}: vault locked - run \`veilio vault unlock\`, then \`veilio rules pull\`.`
    )
  if (s.teamLocked > 0)
    out.push(
      `${n(s.teamLocked)}: team key locked - run \`veilio team unlock\`, then \`veilio rules pull\`.`
    )
  if (s.unopenable > 0)
    out.push(`${n(s.unopenable)}: could not be opened with the keys on this machine, and skipped.`)
  if (s.refused > 0)
    out.push(
      `${n(s.refused)}: refused as unsafe to apply (an engine placeholder, a pattern rules do not support, or a team whitelist that does not name the identifiers it keeps), and skipped.`
    )
  if (s.teamUnconfirmed > 0)
    out.push(
      `${noun ? `${s.teamUnconfirmed} team rule${s.teamUnconfirmed === 1 ? '' : 's'}` : s.teamUnconfirmed} not applied: they are sealed under a team key whose sender you have not confirmed. \`veilio team unlock\` shows that key.`
    )
  return out
}
