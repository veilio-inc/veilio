import type { SymbolMap } from './types.js';
import { type KdfParams } from './envelope.js';
/** The envelope's algorithm marker. Stored, checked, never inferred. */
export declare const VAULT_ENVELOPE_ALG: "AES-256-GCM-PBKDF2";
/** What a NEW vault is created with. Matches the browser's `CURRENT_VAULT_KDF`. */
export declare const CURRENT_VAULT_KDF: KdfParams;
/**
 * What a vault created before parameters were recorded must be read with.
 *
 * A historical fact, not policy. Editing it to track `CURRENT_VAULT_KDF` would
 * silently orphan every map encrypted under the old value — the derivation
 * yields a DIFFERENT key rather than an error, so nothing would report it.
 */
export declare const LEGACY_VAULT_KDF: KdfParams;
/** Size of a vault salt, in bytes. 256 bits, per NIST. */
export declare const VAULT_SALT_BYTES = 32;
export declare class VaultEnvelopeError extends Error {
    constructor(message?: string);
}
export interface VaultEnvelope {
    v: 1;
    alg: typeof VAULT_ENVELOPE_ALG;
    /** base64 */
    iv: string;
    /** base64 ciphertext */
    data: string;
}
/** A fresh vault salt. */
export declare function randomVaultSalt(): Uint8Array;
/**
 * Derive the vault key.
 *
 * `kdf` comes from the server alongside the salt for an existing vault, and
 * defaults to the current parameters when minting a new one. Passing the WRONG
 * parameters yields a different key rather than an error — which is why a
 * verifier exists, and why nothing here tries to detect it.
 */
export declare function deriveVaultKey(passphrase: string, salt: Uint8Array, kdf?: KdfParams): Promise<CryptoKeyLike>;
/** An opaque derived key. The engine declares no DOM types; see envelope.ts. */
export type CryptoKeyLike = {
    readonly type: string;
};
export declare function encryptMapForVault(key: CryptoKeyLike, map: SymbolMap): Promise<VaultEnvelope>;
/**
 * Open a vault envelope.
 *
 * The version and algorithm are checked BEFORE any decryption is attempted, so
 * a future format arrives as "unrecognized" rather than as a decrypt failure
 * that reads like a wrong passphrase. The result is validated on the way out for
 * the same reason it is in `openMap`: authenticated ciphertext proves the bytes
 * came from the right key, not that they are a symbol map.
 */
export declare function decryptMapFromVault(key: CryptoKeyLike, envelope: VaultEnvelope): Promise<SymbolMap>;
/** Parse a stored envelope string, or say plainly that it is not one. */
export declare function parseVaultEnvelope(raw: string): VaultEnvelope;
/**
 * Check a passphrase without the server learning it.
 *
 * The verifier is a known constant encrypted under the key. Only somebody
 * holding the right passphrase decrypts it back to the constant, and the server
 * stores it opaquely.
 */
export declare function checkVaultVerifier(key: CryptoKeyLike, verifier: string): Promise<boolean>;
