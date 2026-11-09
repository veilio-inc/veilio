// The record of the maps Veilio wrote (spec 085 R2-3, founder 2026-11-09).
//
// A map that came with the files - an archive that ships its own `.git`, with
// the map left untracked - cannot be told from one this checkout wrote by
// asking git. So every tool that writes `.veilio/map.json` or `aliases.json`
// records, under the user's own `~/.veilio`, the hashes of what it wrote, per
// project root; the guard puts back unseen only names from a map that matches.
// The format lives here so the CLI and the guard cannot disagree; each does
// its own file IO and hashing (SHA-256, lowercase hex).
/** The record's file name in `~/.veilio`. */
export const WRITTEN_RECORD_FILE = 'written.json';
const VALUE = /^[0-9a-f]{64}:[0-9a-f]{64}$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
/** What is recorded for a project: the map's hash, then the aliases file's
 *  (an absent file hashes as the empty text). */
export function writtenRecordValue(mapSha256, aliasesSha256) {
    return `${mapSha256}:${aliasesSha256}`;
}
/** The record, real project root to value; null when it is not one. */
export function parseWrittenRecord(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return null;
    const out = Object.create(null);
    for (const [root, value] of Object.entries(parsed)) {
        if (!ABSOLUTE.test(root) || typeof value !== 'string' || !VALUE.test(value))
            return null;
        out[root] = value;
    }
    return { ...out };
}
