import type { CryptoKeyLike } from './vault.js';
/** The asymmetric algorithm a user's keypair uses. */
export declare const USER_KEY_ALG: "X25519";
/** Tag on a team map at rest.
 *
 *  Deliberately NOT the vault envelope's tag. That one is AES-256-GCM-PBKDF2,
 *  and a team key comes from ECDH + HKDF rather than a passphrase — reusing the
 *  tag would tell a future reader that one person's passphrase loss takes the
 *  map with it, which is the opposite of how a team key behaves. Checked on the
 *  way in, so the two schemes cannot be confused silently. */
declare const TEAM_ENVELOPE_ALG: "AES-256-GCM-TEAM";
export declare class TeamKeyError extends Error {
    constructor(message: string);
}
/** A team map at rest, inside Veilio's outer layer. */
export interface TeamMapEnvelope {
    v: 1;
    alg: typeof TEAM_ENVELOPE_ALG;
    iv: string;
    data: string;
}
/**
 * The context a wrapping key is bound to.
 *
 * Without this, `deriveWrappingKey(alicePriv, bobPub)` produced the SAME key
 * for every team and every version — so a wrap addressed to Bob in team A
 * decrypted verbatim when re-filed as team B, or as a later version. Two things
 * followed: team B's maps could be encrypted under team A's key with nobody
 * seeing an anomaly, and a v1 wrap copied into a v2 row would hand a removed
 * member the old key while their client believed it was the new one — defeating
 * the rotation that removal exists to trigger.
 *
 * Both parties can reconstruct this independently: the granter knows all four
 * fields, and the recipient reads teamId and version from the row, the
 * granter's key from the wrap itself, and supplies their own.
 */
export interface WrapContext {
    teamId: string;
    version: number;
    /** Base64 public key of whoever is granting. */
    granterPublicKey: string;
    /** Base64 public key of whoever receives. */
    recipientPublicKey: string;
}
/** Import a teammate's public key from its stored base64 form. */
export declare function importPublicKey(publicKeyBase64: string): Promise<CryptoKeyLike>;
/**
 * Recover the private key. Throws if the vault key is wrong or the blob is
 * damaged.
 *
 * The private half is stored wrapped under the vault key — derived from a
 * passphrase the server never receives — so what the server holds is a blob it
 * cannot open, exactly like a personal map envelope. Lose the passphrase and
 * you lose the private key, and with it every team key wrapped to it. That is
 * the contract, not a gap.
 */
export declare function unwrapPrivateKey(vaultKey: CryptoKeyLike, privateKeyEncrypted: string): Promise<CryptoKeyLike>;
/**
 * Derive the symmetric key used to wrap a team key for one recipient.
 *
 * ECDH gives a shared secret, not a key — so it goes through HKDF rather than
 * being used directly. The info string binds the result to this exact
 * (team, version, granter, recipient), so a wrap moved to any other context
 * fails its authentication tag instead of opening.
 */
export declare function deriveWrappingKey(privateKey: CryptoKeyLike, peerPublicKey: CryptoKeyLike, ctx: WrapContext): Promise<CryptoKeyLike>;
/** Open one member's wrap and recover the team key inside it. */
export declare function unwrapTeamKey(wrapJson: string, myPrivateKey: CryptoKeyLike, ctx: {
    teamId: string;
    version: number;
    myPublicKey: string;
}): Promise<CryptoKeyLike>;
/**
 * The raw team key, base64, so a client can hold it between processes.
 *
 * This exists for one caller: an MCP server starts inside a coding agent with
 * nobody present to type a passphrase, so the key it needs has to have been put
 * somewhere by an earlier, interactive run. Exporting the TEAM key rather than
 * the vault key is the narrower choice of the two — it opens team maps and
 * nothing else, where the vault key would also open every personal map and
 * unwrap the private key that can open any wrap addressed to this account.
 *
 * Whatever holds the result holds the team's maps. That is a real cost and the
 * caller is responsible for it: `packages/cli/src/team-unlock.ts` writes it
 * 0600 beside the session token, with an expiry, and says so.
 */
export declare function exportTeamKey(key: CryptoKeyLike): Promise<string>;
/** The reverse, for a client reading one back off disk. */
export declare function importTeamKey(rawBase64: string): Promise<CryptoKeyLike>;
/** Open a team map with the team key held. */
export declare function decryptTeamMap(teamKey: CryptoKeyLike, env: TeamMapEnvelope): Promise<Record<string, string>>;
/**
 * Open a team map with whichever held key fits.
 *
 * Mid-rotation a team's maps sit under two versions at once: the ones already
 * rewritten under the new key, and the ones not yet reached. A member holds both
 * wraps, and has no way to tell from the envelope which key a given map wants —
 * the envelope carries a *schema* version, not a key version.
 *
 * Rather than stamp the key version into the envelope, this trials each held key
 * newest-first. AES-GCM authenticates, so a wrong key fails cleanly instead of
 * returning plausible nonsense — the same property `decryptTeamMap` already
 * relies on. That makes trial decryption exact rather than a guess, and avoids a
 * format field whose absence would have needed a "treat missing as v1" rule:
 * precisely the legacy branch that outlives the thing it was written for.
 *
 * Newest-first because during a rotation most maps are already rewritten, and
 * because a map that opens under two versions cannot exist — the keys differ.
 */
export declare function decryptTeamMapWithAny(keys: readonly {
    version: number;
    key: CryptoKeyLike;
}[], env: TeamMapEnvelope): Promise<Record<string, string>>;
export {};
