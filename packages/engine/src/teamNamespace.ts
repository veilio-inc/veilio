/**
 * The shared-placeholder namespace for a team.
 *
 * This is the function that lets team maps stop being server-readable. A server
 * that merges them has to decrypt every one, which is the only reason it would
 * hold a key that can read them at all. Merging on the client removes that
 * requirement, so the merge has to run wherever a client is: the browser, and
 * the MCP server behind a coding agent.
 *
 * It lives in the engine because it is called from more than one place and the
 * rule it encodes is a team's shared contract, not any one caller's private
 * detail. The alternative — a copy per client — is the failure this design
 * exists to prevent: two implementations can drift between the assertion that
 * they agree and the next commit, and the symptom would be a team silently
 * forking its placeholder numbering, with every repository's tests green.
 *
 * Ported from `veilio-cloud`'s `@veilio-inc/shared`, which was its first home
 * when the only two callers were that server and that browser.
 *
 * The rule: sort by `createdAt` ascending, then first-write-wins on the
 * placeholder **and** on the identifier.
 * The second half looks arbitrary and is not: without it two placeholders could
 * bind to one identifier, and a restore would have no way to choose between
 * them.
 */

export interface TeamMapEntry {
  createdAt: string
  /** Decrypted mapping, or null when this map could not be opened. */
  map: Record<string, string> | null
}

export function mergeTeamNamespace(entries: readonly TeamMapEntry[]): Record<string, string> {
  // Copy before sorting: callers pass state they still hold.
  const sorted = [...entries].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  )

  const merged: Record<string, string> = {}
  const claimedNames = new Set<string>()

  for (const entry of sorted) {
    // A map we could not decrypt is skipped, never fatal - one unreadable row
    // must not cost a whole team its namespace.
    if (!entry.map) continue

    for (const [placeholder, identifier] of Object.entries(entry.map)) {
      if (placeholder in merged) continue
      if (claimedNames.has(identifier)) continue
      merged[placeholder] = identifier
      claimedNames.add(identifier)
    }
  }

  return merged
}
