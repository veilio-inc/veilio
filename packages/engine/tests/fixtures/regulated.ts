import { detectSecrets } from '../../src/secrets.js'

/**
 * Fixtures for the regulated-identifier round-trip, and a guard that they are
 * actually detected.
 *
 * ── Read this before adding one ──
 *
 * `looksLikePan` contains `if (KNOWN_TEST_PANS.has(digits)) return false`.
 * Stripe's published test card `4242424242424242` therefore produces **no
 * finding**, deliberately, to hold the false-positive rate at zero.
 *
 * A fixture on that exclusion list asserts nothing while appearing to pass.
 * That is not hypothetical: a probe built on `4242…4242` during this feature's
 * investigation concluded payment cards passed through the engine verbatim and
 * that a detector needed building. Both were wrong — a real-shaped PAN was
 * being caught and redacted throughout.
 *
 * The same trap exists for the other two: an IBAN that fails mod-97 or a PESEL
 * that fails its check digit is simply not detected, and every assertion
 * downstream of it becomes vacuous.
 *
 * So this module asserts its own fixtures at import time. A bad fixture fails
 * loudly, here, instead of quietly turning a suite green.
 */

/** mod-97 valid (ISO 13616). */
export const VALID_IBAN = 'GB29NWBK60161331926819'

/** A second, distinct valid IBAN — for "two different values" cases. */
export const VALID_IBAN_2 = 'DE89370400440532013000'

/** Check-digit and date valid. */
export const VALID_PESEL = '44051401359'

/** Luhn-valid, Visa IIN, and NOT a published test number. */
export const VALID_PAN = '4539578763621486'

/**
 * A well-formed credential of a `destroy` type.
 *
 * The same obviously-fake value the rest of the suite uses. A first version of
 * this fixture invented a longer, more realistic-looking key and GitHub's push
 * protection blocked the push — correctly: this is a PUBLIC repository, and a
 * string that scans as a live Stripe key does not belong in one whether or not
 * it happens to be real. Keep it short, keep it alphabetic, keep it shared with
 * the existing tests.
 */
export const CREDENTIAL = 'sk_live_51H8xQ2ABCDEFGHIJKLMNOP'

/** Every fixture, with the type it must be detected as. */
const MUST_DETECT: ReadonlyArray<readonly [string, string]> = [
  [VALID_IBAN, 'iban'],
  [VALID_IBAN_2, 'iban'],
  [VALID_PESEL, 'pesel'],
  [VALID_PAN, 'payment-card'],
  [CREDENTIAL, 'stripe-key'],
]

for (const [value, expectedType] of MUST_DETECT) {
  const findings = detectSecrets(`const x = "${value}"`)
  const hit = findings.find((f) => f.type === expectedType)
  if (!hit) {
    throw new Error(
      `Fixture "${value}" is not detected as ${expectedType}. ` +
        `Every assertion built on it would pass vacuously. ` +
        `For a card: check it is not in KNOWN_TEST_PANS. ` +
        `For an IBAN or PESEL: check the checksum.`
    )
  }
}
