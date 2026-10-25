export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SecretType = 'aws-access-key' | 'aws-secret-key' | 'private-key' | 'stripe-key' | 'github-token' | 'gitlab-token' | 'slack-token' | 'slack-webhook' | 'discord-token' | 'openai-key' | 'anthropic-key' | 'google-api-key' | 'gcp-service-account' | 'azure-key' | 'npm-token' | 'pypi-token' | 'sendgrid-key' | 'twilio-key' | 'mailgun-key' | 'datadog-key' | 'hugging-face-token' | 'supabase-key' | 'square-token' | 'shopify-token' | 'cloudflare-token' | 'jwt' | 'bearer-token' | 'basic-auth' | 'connection-string' | 'password-assignment' | 'possible-credential' | 'high-entropy-string' | 'email' | 'private-ip' | 'iban' | 'payment-card' | 'pesel';
export interface SecretFinding {
    type: SecretType;
    severity: SecretSeverity;
    /** Human-readable label for UI. */
    label: string;
    /** 1-based line number of the match. */
    line: number;
    /** 1-based column of the match within its line. */
    column: number;
    /** Character length of the matched secret. */
    length: number;
    /** Truncated `abcd…wxyz` form. Never the full secret — findings are rendered
     *  in the UI and may end up in logs; a finding carrying the whole value would
     *  re-create the leak it exists to warn about. */
    preview: string;
    /** Whether this finding was redacted under the active policy.
     *
     *  Means exactly one thing and keeps meaning it: THE VALUE WAS DESTROYED.
     *  A reversibly masked identifier reports `false` here — it was replaced, but
     *  it is recoverable, so calling it redacted would be a lie to every consumer
     *  rendering this field. Read `disposition` for the finer answer. */
    redacted: boolean;
    /** What was actually done with the value. See `Disposition`. */
    disposition: Disposition;
}
/**
 * What happens to a detected value. Exactly one of three, total over every type.
 *
 *  - `destroy`  the value is replaced and recorded NOWHERE. Unrecoverable by
 *               construction, not by convention: nothing writes it to the map.
 *  - `mask`     the value is replaced by a placeholder recorded in the map, so
 *               `restore()` brings it back.
 *  - `report`   the value is left exactly as written and only reported.
 *
 * One field rather than two booleans on purpose: two booleans can be set to a
 * fourth, meaningless combination, and "destroyed AND recoverable" is the one
 * state this whole design exists to make unrepresentable.
 */
export type Disposition = 'destroy' | 'mask' | 'report';
/** How `anonymize` treats detected credentials. */
export type SecretPolicy = 'redact' | 'warn' | 'off';
/** Luhn (mod-10). Payment cards, and a good many national IDs. */
export declare function luhnValid(value: string): boolean;
/**
 * IBAN mod-97 (ISO 13616). Move the first four characters to the end, map
 * letters to two-digit numbers, and the whole thing mod 97 must be 1.
 *
 * Computed in chunks because the expanded number can exceed 2^53 — doing it in
 * one `Number()` silently loses precision and starts accepting invalid IBANs,
 * which is worse than not checking at all.
 */
export declare function ibanValid(value: string): boolean;
/**
 * PESEL — the Polish national identification number.
 *
 * Eleven digits: a date, a serial, and a weighted check digit. The date is
 * checked as well as the checksum, because eleven digits is a common enough
 * shape in source that the check digit alone leaves too many coincidences.
 */
export declare function peselValid(value: string): boolean;
/**
 * The grade each rule carries, derived from the table above rather than
 * restated. A second hand-written copy is one that drifts.
 *
 * Exported because a caller that renders findings has to rank and style them,
 * and the alternative is every caller hardcoding its own idea of which types
 * are alarming — which is how the grades stopped meaning anything the first time.
 */
export declare const SECRET_SEVERITIES: Readonly<Record<SecretType, SecretSeverity>>;
/**
 * What is done with each type's value, derived from the rule table.
 *
 * Derived rather than restated, for the same reason `SECRET_SEVERITIES` above
 * is: a second hand-written copy is one that drifts. This feature exists
 * because two DOCUMENTS holding the same decision drifted apart for eleven
 * weeks with nothing forcing them into the same room; repeating that shape one
 * layer down would be a poor lesson to take from it.
 */
export declare const SECRET_DISPOSITIONS: Readonly<Record<SecretType, Disposition>>;
/** Shannon entropy in bits per character. */
export declare function shannonEntropy(value: string): number;
/** Show enough of the value to be recognisable, never enough to be usable. */
export declare function previewSecret(value: string): string;
/** A `mask`-disposition value, handed to the masking pass to replace. */
export interface RegulatedSpan {
    type: SecretType;
    /** The original value, verbatim. Goes into the SymbolMap, deliberately. */
    value: string;
}
export interface SecretScan {
    findings: SecretFinding[];
    /** Input with DESTROYED findings replaced. Identical to the input under the
     *  `warn` and `off` policies.
     *
     *  `mask` values are NOT replaced here — see `regulated`. */
    code: string;
    /**
     * Values this scan detected but deliberately did not touch, for the masking
     * pass to replace reversibly.
     *
     * They are handed over rather than replaced here because reversible masking
     * needs a map, a placeholder counter and a value→placeholder table, all of
     * which the masking pass already owns and maintains for manual marks. Doing
     * it here would mean re-implementing them inside the one module whose stated
     * purpose is that values never reach the map — and that comment would then be
     * false, which is the failure shape this codebase keeps finding.
     *
     * Empty under the `warn` and `off` policies: a user who asked not to have
     * their code modified does not get map entries written behind that request.
     */
    regulated: RegulatedSpan[];
}
/**
 * Does a value of this type get destroyed?
 *
 * Keyed on TYPE, never on severity, and that distinction is the point. Severity
 * used to decide this, which quietly welded two unrelated questions together:
 * "how alarming should this look?" and "should we destroy this value?". A
 * presentation change then became a security change — dropping a token's grade
 * to calm the panel would also stop redacting it, in a diff that looks
 * cosmetic.
 */
export declare function destroysValue(type: SecretType): boolean;
/**
 * Does a value of this type stop the paste?
 *
 * Deliberately a SEPARATE function from `destroysValue`, even though the two
 * currently return the same answer for every type. They answer different
 * questions and are allowed to diverge: destruction is about what we keep,
 * blocking is about what we let the user do.
 *
 * One shared predicate is what made them inseparable before, so that a change
 * to either silently changed both. Regulated identifiers are the first case
 * where they differ in intent — a customer's own IBAN is masked but must not
 * stop the paste, because blocking exists to stop a LIVE CREDENTIAL reaching a
 * model and refusing the billing code this tool was built for is not that.
 *
 * Like its sibling, it must never consult `SecretSeverity`.
 */
export declare function blocksPaste(type: SecretType): boolean;
/** Detect credentials in `code` without modifying it. */
export declare function detectSecrets(code: string): SecretFinding[];
/**
 * Detect credentials and, under the `redact` policy, replace critical/high
 * findings with `__REDACTED_<TYPE>_<n>__` tokens.
 *
 * The replacement is placeholder-shaped, so the engine's existing
 * PLACEHOLDER_TOKEN guard keeps it out of identifier extraction. Because it is
 * never written to the SymbolMap, `restore()` leaves it in place — the redaction
 * is one-way by construction, not by convention.
 */
export declare function scanSecrets(code: string, policy?: SecretPolicy): SecretScan;
/** True when the scan found anything that should stop a user from pasting. */
export declare function hasBlockingSecrets(findings: readonly SecretFinding[]): boolean;
/** Count findings by severity, for badges and audit records. */
export declare function summarizeSecrets(findings: readonly SecretFinding[]): Record<SecretSeverity, number>;
