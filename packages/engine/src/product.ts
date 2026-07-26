// Product identity, in one place.
//
// The name appears in the downstream-AI preamble, the CLI binary, the on-disk
// store directory, and every user-facing string in the MCP server. A rename that
// has to be chased through all of those is a rename that gets done badly, so
// they all read from here.
//
// Renaming checklist (everything else is derived):
//   1. Change the three constants below.
//   2. `npm pkg set name=@<scope>/<pkg>` per package, and the `bin` key in
//      packages/cli/package.json.

/** Display name. Appears in the AI preamble and all human-facing output. */
export const PRODUCT_NAME = 'Veilio'

/** Command name for the CLI and in documentation examples. */
export const BIN_NAME = 'veilio'

/** Project-local directory holding the symbol map. */
export const STORE_DIR = '.veilio'

/** Prefix for irreversible credential redactions. Deliberately NOT derived from
 *  the product name: it appears in code sent to third-party models and read back
 *  from their replies, so it must stay stable across any rebrand. */
export const REDACTION_PREFIX = '__REDACTED_'
