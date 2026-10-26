/** The valid keys of an options type, written once and checked by the
 *  compiler both ways: a missing key or an extra one does not compile. */
export declare function optionKeys<T>(keys: Record<keyof T, true>): readonly string[];
/** The keys of `options` that are not in `valid`. */
export declare function unknownKeys(options: object, valid: readonly string[]): string[];
/** The error for unknown option keys: `fn: unknown option 'style'. Valid
 *  options: a, b.` */
export declare function unknownOptionError(fn: string, unknown: readonly string[], valid: readonly string[]): TypeError;
/** Throw when `options` holds a key that is not in `valid`. */
export declare function assertKnownOptions(fn: string, options: object | undefined, valid: readonly string[]): void;
