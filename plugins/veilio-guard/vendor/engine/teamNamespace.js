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
 *
 * `analyzeTeamNamespace` reads the maps three ways (spec 017); it moved here from
 * Cloud's shared package (spec 028) so the web app, the CLI and the MCP server
 * all read a team's maps by one definition.
 */
const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/;
export function analyzeTeamNamespace(entries) {
    // Copy before sorting: callers pass state they still hold.
    const sorted = [...entries].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
    const namespace = {};
    const claimedNames = new Set();
    const meanings = new Map();
    const highest = {};
    for (const entry of sorted) {
        // A map we could not decrypt is skipped, never fatal - one unreadable row
        // must not cost a whole team its namespace.
        if (!entry.map)
            continue;
        for (const [placeholder, identifier] of Object.entries(entry.map)) {
            const seen = meanings.get(placeholder) ?? new Set();
            seen.add(identifier);
            meanings.set(placeholder, seen);
            const numbered = NUMBERED.exec(placeholder);
            if (numbered) {
                const n = Number(numbered[2]);
                if (n > (highest[numbered[1]] ?? 0))
                    highest[numbered[1]] = n;
            }
            if (placeholder in namespace)
                continue;
            if (claimedNames.has(identifier))
                continue;
            namespace[placeholder] = identifier;
            claimedNames.add(identifier);
        }
    }
    const aliases = {};
    const conflicts = {};
    for (const [placeholder, seen] of meanings) {
        if (seen.size > 1) {
            conflicts[placeholder] = seen.size;
        }
        else if (!(placeholder in namespace)) {
            aliases[placeholder] = [...seen][0];
        }
    }
    return { namespace, aliases, conflicts, highest };
}
export function mergeTeamNamespace(entries) {
    return analyzeTeamNamespace(entries).namespace;
}
