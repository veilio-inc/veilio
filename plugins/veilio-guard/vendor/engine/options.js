// Runtime checks on the option objects of the public API.
//
// TypeScript refuses an unknown option key, but a JavaScript caller, a cast or
// a spread of a wider object gets no such check, and an option the engine no
// longer reads used to be ignored without a word. Worse, `anonymize` took any
// object of unknown keys as a positional symbol map and stored them in it
// (`{ style: 'plain' }`, an option removed before 1.0.0, reached Cloud as a
// map entry). An unknown key is a mistake, so it throws, naming itself and the
// keys that are valid.
/** The valid keys of an options type, written once and checked by the
 *  compiler both ways: a missing key or an extra one does not compile. */
export function optionKeys(keys) {
    return Object.keys(keys);
}
/** The keys of `options` that are not in `valid`. */
export function unknownKeys(options, valid) {
    return Object.keys(options).filter((key) => !valid.includes(key));
}
/** The error for unknown option keys: `fn: unknown option 'style'. Valid
 *  options: a, b.` */
export function unknownOptionError(fn, unknown, valid) {
    const named = unknown.map((key) => `'${key}'`).join(', ');
    return new TypeError(`${fn}: unknown option${unknown.length === 1 ? '' : 's'} ${named}. Valid options: ${valid.join(', ')}.`);
}
/** Throw when `options` holds a key that is not in `valid`. */
export function assertKnownOptions(fn, options, valid) {
    if (options === undefined || options === null)
        return;
    const unknown = unknownKeys(options, valid);
    if (unknown.length > 0)
        throw unknownOptionError(fn, unknown, valid);
}
