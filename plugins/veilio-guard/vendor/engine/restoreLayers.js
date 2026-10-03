export function restoreLayers(input) {
    const { own, team } = input;
    if (!team)
        return { map: { ...own }, disputedIn: () => [], locallyNumberedIn: () => [] };
    const layer = { ...team.aliases, ...team.namespace };
    for (const placeholder of Object.keys(team.conflicts))
        delete layer[placeholder];
    // The own map wins only where it is provably in the team's numbering (spec 028
    // R5): the team gives that placeholder the same identifier, the team does not
    // know the placeholder at all, or the team's maps dispute it and the own map
    // settles which meaning was used. An own entry the team CONTRADICTS was
    // numbered locally - signed out, during a lapse, before `veilio team unlock` -
    // and its number means something else in the team's maps. Neither meaning is
    // safe for this text, so the placeholder is left and named. (The web app's own
    // map is numbered from the team's reservations, so for it this never fires.)
    const contradicted = Object.keys(own).filter((p) => !(p in team.conflicts) && p in layer && layer[p] !== own[p]);
    const map = { ...layer, ...own };
    for (const p of contradicted)
        delete map[p];
    const unsettled = Object.keys(team.conflicts).filter((p) => !(p in own));
    return {
        map,
        disputedIn: (text) => unsettled.filter((p) => appearsAsToken(text, p)),
        locallyNumberedIn: (text) => contradicted.filter((p) => appearsAsToken(text, p)),
    };
}
/** A whole placeholder token - not a piece of a longer identifier or number. */
function appearsAsToken(text, placeholder) {
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}
/** How the CLI and the MCP name the disputed placeholders they left - one wording. */
export function disputedNote(placeholders) {
    return (`left as is: ${placeholders.join(', ')}. The team's saved maps give ` +
        `${placeholders.length === 1 ? 'this placeholder' : 'these placeholders'} different identifiers, ` +
        'so restoring would be a guess.');
}
/**
 * How the CLI and the MCP name a placeholder they left because this project's
 * map and the team's maps disagree on it. It states the disagreement, which is
 * known, and gives the causes only as examples: a map pulled from Cloud
 * disagrees just as one numbered while signed out does (staging walk,
 * 2026-10-01).
 */
export function locallyNumberedNote(placeholders) {
    const one = placeholders.length === 1;
    return (`left as is: ${placeholders.join(', ')}. This project's map and the team's maps give ` +
        `${one ? 'this placeholder' : 'these placeholders'} different identifiers - for example ` +
        `${one ? 'it was' : 'they were'} numbered while signed out or before \`veilio team unlock\`, ` +
        'or come from a personal map - so restoring would be a guess.');
}
/** How the CLI and the MCP name the altered placeholders they left (spec 029). */
export function alteredNote(placeholders) {
    const one = placeholders.length === 1;
    return (`left as is: ${placeholders.join(', ')}. ${one ? 'It looks' : 'They look'} like ` +
        `${one ? 'a placeholder' : 'placeholders'} whose shape the AI changed (case or underscores), ` +
        `so nothing could restore ${one ? 'it' : 'them'}. Ask the AI to use the placeholders exactly as given.`);
}
