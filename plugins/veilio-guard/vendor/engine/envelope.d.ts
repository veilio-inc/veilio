/**
 * The encrypted `.veilio` file format, and the key derivation behind it.
 *
 * This lives in the engine because two editions have to agree on it byte for
 * byte. A map sealed in the browser and opened from a terminal is the point of
 * the feature; two implementations of one format is the arrangement where one
 * gets a parameter change and the other does not, and the symptom is a file
 * nobody can open. The engine is already public, already zero-dependency, and
 * already owns the map type, so it is the one place both callers can reach.
 *
 * Everything here runs on WebCrypto through `globalThis.crypto`, which is
 * present in browsers and in Node from 19 onward. Deliberately NOT
 * `node:crypto`: importing it would give the engine a Node-only module and cost
 * it the browser, which is half its audience.
 */
import type { SymbolMap } from './types.js';
/**
 * Parameters recorded alongside every artifact they produced.
 *
 * A KDF's cost is expected to rise, and PBKDF2 is expected to give way to a
 * memory-hard KDF entirely. Neither is possible unless each artifact records
 * what it was created under: raising a hardcoded constant re-derives a DIFFERENT
 * key from the same passphrase, which silently orphans every file encrypted
 * under the old one. Recording it makes that change a migration rather than data
 * loss.
 */
export interface KdfParams {
    name: 'PBKDF2-SHA256';
    iterations: number;
}
/** What new files are created with. Safe to raise — every existing file carries
 *  its own parameters, or falls back to the frozen legacy value below. */
export declare const CURRENT_FILE_KDF: KdfParams;
/** What files written BEFORE parameters were recorded must be read with. A
 *  historical fact, not policy: editing it to track CURRENT_FILE_KDF stops
 *  previously exported files decrypting. Files were raised from 100k to 600k,
 *  and this is exactly what keeps the older ones importable. */
export declare const LEGACY_FILE_KDF: KdfParams;
export declare class KdfParamsError extends Error {
    constructor(message?: string);
}
/**
 * Validate KDF parameters read off an artifact.
 *
 * `raw` absent means the artifact predates parameter recording, so `fallback`
 * applies. Anything present but unrecognised throws rather than silently
 * deriving the wrong key — a wrong key surfaces as "decryption failed", which
 * reads to a user as a corrupt file rather than a version mismatch.
 */
export declare function parseKdfParams(raw: unknown, fallback: KdfParams): KdfParams;
/**
 * NIST SP 800-63B puts the lever on length rather than composition rules:
 * mandated symbol-and-digit recipes push people toward predictable
 * substitutions without adding entropy. Twelve is above the 8-character minimum
 * that guidance sets, warranted because this artifact is offline-attackable
 * rather than rate-limited by a server.
 */
export declare const MIN_PASSPHRASE_LENGTH = 12;
export declare class WeakPassphraseError extends Error {
    constructor(message: string);
}
/**
 * A floor, not a strength meter, and the difference is worth being blunt about.
 * It rejects choices that are bad by construction. It cannot tell that
 * `correcthorse1` is poor, and does not pretend to — a green tick on a mediocre
 * passphrase is worse than no tick, because it converts the user's own judgement
 * into misplaced confidence.
 *
 * Called inside `sealMap` rather than at the call site, so no future caller can
 * write a file that skips the floor.
 */
export declare function assertUsablePassphrase(passphrase: string): void;
export declare class InvalidMapError extends Error {
    constructor(message: string);
}
/**
 * A decrypted file is authenticated, not trusted.
 *
 * Authentication proves the author knew the passphrase. Where maps move between
 * teammates that proves the author is a colleague, not that the contents are
 * benign — whatever a map holds is substituted into restored source, which the
 * reader then pastes into an editor.
 *
 * This cannot make an imported map safe and does not pretend to. It makes a
 * malformed or hostile one fail loudly at the boundary instead of quietly
 * deforming the restore.
 */
export declare function parseSymbolMap(raw: unknown): SymbolMap;
declare const ENVELOPE_ALG = "AES-256-GCM-PBKDF2";
export interface VeilioFile {
    v: 1;
    alg: typeof ENVELOPE_ALG;
    /** Absent in files written before parameters were recorded; those are read
     *  with LEGACY_FILE_KDF, which is why that constant stays frozen. */
    kdf?: KdfParams;
    salt: string;
    iv: string;
    data: string;
}
/**
 * The host surface this module needs, declared rather than imported.
 *
 * The engine's tsconfig sets `lib: ["ES2022"]` with no DOM, on purpose — it runs
 * in a browser, in Node, and in a worker, and none of those should be assumed.
 * Adding "DOM" to satisfy four type names would pull a whole browser API surface
 * into a package that touches none of it, and `@types/node` would be a
 * dependency in a package whose selling point is having none.
 *
 * So the contract is written out. It is four methods, it is what WebCrypto
 * guarantees in every environment listed above, and a host missing any of them
 * fails at `subtle()` with a sentence saying which environments qualify.
 */
interface WebCryptoKey {
    readonly type: string;
}
interface WebCryptoSubtle {
    importKey(format: 'raw' | 'pkcs8', keyData: Uint8Array | ArrayBuffer, algorithm: string | {
        name: string;
        length?: number;
    }, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
    deriveKey(algorithm: {
        name: string;
        salt: Uint8Array;
        iterations: number;
        hash: string;
    } | {
        name: 'HKDF';
        hash: string;
        salt: Uint8Array;
        info: Uint8Array;
    }, baseKey: WebCryptoKey, derived: {
        name: string;
        length: number;
    }, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
    /** ECDH. Produces a shared secret, which is bits rather than a key — HKDF
     *  above is what turns it into one. */
    deriveBits(algorithm: {
        name: string;
        public: WebCryptoKey;
    }, baseKey: WebCryptoKey, length: number): Promise<ArrayBuffer>;
    /** Only ever called on a key already marked extractable, and only for the
     *  team key — so a client that has been granted one can hold it across
     *  processes instead of re-deriving it from a passphrase that nobody is
     *  present to type. */
    exportKey(format: 'raw', key: WebCryptoKey): Promise<ArrayBuffer>;
    encrypt(algorithm: {
        name: string;
        iv: Uint8Array;
    }, key: WebCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
    decrypt(algorithm: {
        name: string;
        iv: Uint8Array;
    }, key: WebCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
}
/**
 * The same accessor, exported for `vault.ts`.
 *
 * The vault envelope is a sibling format keyed off a server-held salt rather
 * than one carried in the file, so it needs this surface without duplicating the
 * declaration — a second copy of the WebCrypto contract is a second thing to get
 * subtly wrong.
 */
export declare function webCryptoSubtle(): WebCryptoSubtle;
/** Cryptographically random bytes, for `vault.ts`'s salts and IVs. */
export declare function randomBytes(n: number): Uint8Array;
export declare function toBase64(buf: ArrayBuffer | Uint8Array): string;
export declare function fromBase64(s: string): Uint8Array;
/** Seal a symbol map into the `.veilio` file format. Returns the file's text. */
export declare function sealMap(map: SymbolMap, passphrase: string): Promise<string>;
/** Open a `.veilio` file. Throws on a wrong passphrase, an unknown format, or a
 *  map that decrypts but does not validate. */
export declare function openMap(fileContent: string, passphrase: string): Promise<SymbolMap>;
export {};
