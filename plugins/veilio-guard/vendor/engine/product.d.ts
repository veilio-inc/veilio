/** Display name. Appears in the AI preamble and all human-facing output. */
export declare const PRODUCT_NAME = "Veilio";
/** Command name for the CLI and in documentation examples. */
export declare const BIN_NAME = "veilio";
/** Project-local directory holding the symbol map. */
export declare const STORE_DIR = ".veilio";
/** Prefix for irreversible credential redactions. Deliberately NOT derived from
 *  the product name: it appears in code sent to third-party models and read back
 *  from their replies, so it must stay stable across any rebrand. */
export declare const REDACTION_PREFIX = "__REDACTED_";
