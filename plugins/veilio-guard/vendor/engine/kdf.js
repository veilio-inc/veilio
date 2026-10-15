// Key-derivation parameters, recorded alongside every artifact they produced.
//
// A KDF's cost is expected to rise over time, and PBKDF2 is expected to give way
// to a memory-hard KDF entirely. Neither is possible unless each artifact records
// the parameters it was created under: raising a hardcoded constant re-derives a
// DIFFERENT key from the same passphrase, which silently orphans everything
// sealed under the old one. Recording the parameters is what makes that change a
// migration rather than data loss.
/** What NEW artifacts are sealed with. Safe to raise: every existing artifact
 *  carries its own parameters, or falls back to the frozen legacy values below.
 *  Sits at the OWASP floor for PBKDF2-HMAC-SHA256. */
export const CURRENT_VAULT_KDF = { name: 'PBKDF2-SHA256', iterations: 600_000 };
/** What artifacts sealed BEFORE parameter recording existed must be read with.
 *
 *  FROZEN. This is a historical fact about artifacts that already exist, not a
 *  policy knob. Editing it to track CURRENT_VAULT_KDF makes every vault sealed
 *  before the edit unopenable, in a diff that reads like hardening. */
export const LEGACY_VAULT_KDF = { name: 'PBKDF2-SHA256', iterations: 600_000 };
// An iteration count read off an artifact drives a derivation loop in the
// reader's process. A hostile artifact claiming a billion iterations would stall
// it, so the value is bounded rather than believed.
//
// The ceiling comes from what an artifact could legitimately need, not from what
// a machine can survive: nothing has ever been sealed above 600,000, and this
// leaves roughly 6x of headroom. The floor is 1 because zero derives nothing.
const MIN_ITERATIONS = 1;
const MAX_ITERATIONS = 4_000_000;
export class KdfParamsError extends Error {
    constructor(message = 'Unsupported key-derivation parameters') {
        super(message);
        this.name = 'KdfParamsError';
    }
}
/**
 * Validate parameters read off an artifact.
 *
 * `raw` absent means the artifact predates parameter recording, so `fallback` —
 * the frozen legacy value for that artifact type — applies. Anything present but
 * unrecognised throws rather than silently deriving the wrong key, because the
 * symptom of the wrong key is "wrong passphrase", which sends the user looking
 * for a problem they do not have.
 */
export function parseKdfParams(raw, fallback) {
    if (raw === undefined || raw === null)
        return fallback;
    if (typeof raw !== 'object')
        throw new KdfParamsError();
    const { name, iterations } = raw;
    if (name !== 'PBKDF2-SHA256')
        throw new KdfParamsError(`Unsupported KDF: ${String(name)}`);
    if (typeof iterations !== 'number' ||
        !Number.isInteger(iterations) ||
        iterations < MIN_ITERATIONS ||
        iterations > MAX_ITERATIONS) {
        throw new KdfParamsError(`Refusing KDF iteration count: ${String(iterations)}`);
    }
    return { name, iterations };
}
