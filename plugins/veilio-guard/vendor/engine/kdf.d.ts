export interface KdfParams {
    name: 'PBKDF2-SHA256';
    iterations: number;
}
/** What NEW artifacts are sealed with. Safe to raise: every existing artifact
 *  carries its own parameters, or falls back to the frozen legacy values below.
 *  Sits at the OWASP floor for PBKDF2-HMAC-SHA256. */
export declare const CURRENT_VAULT_KDF: KdfParams;
/** What artifacts sealed BEFORE parameter recording existed must be read with.
 *
 *  FROZEN. This is a historical fact about artifacts that already exist, not a
 *  policy knob. Editing it to track CURRENT_VAULT_KDF makes every vault sealed
 *  before the edit unopenable, in a diff that reads like hardening. */
export declare const LEGACY_VAULT_KDF: KdfParams;
export declare class KdfParamsError extends Error {
    constructor(message?: string);
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
export declare function parseKdfParams(raw: unknown, fallback: KdfParams): KdfParams;
