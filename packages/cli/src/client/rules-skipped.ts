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
}

export const NO_RULES_SKIPPED: RulesSkipped = {
  vaultLocked: 0,
  teamLocked: 0,
  unopenable: 0,
  refused: 0,
}

/**
 * One sentence per cause, each with what fixes it - the same words from
 * `rules pull`, `scrub` and the MCP server. Empty when nothing was skipped.
 */
export function rulesSkippedSentences(s: RulesSkipped): string[] {
  const n = (count: number): string => `${count} custom rule${count === 1 ? '' : 's'} not applied`
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
    out.push(
      `${n(s.unopenable)}: they could not be opened with the keys on this machine, and were skipped.`
    )
  if (s.refused > 0)
    out.push(
      `${n(s.refused)}: refused as unsafe to apply (an engine placeholder or a pattern that could hang), and skipped.`
    )
  return out
}
