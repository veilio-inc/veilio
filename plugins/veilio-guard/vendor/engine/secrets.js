// Credential detection and irreversible redaction.
//
// Identifier masking protects a domain model. It does nothing for the leak that
// actually costs money: a live key pasted into a model's context window. Worse,
// a credential that happens to be identifier-shaped was previously masked
// *reversibly* — stored as a value in a SymbolMap that Cloud then syncs. That
// is strictly worse than not masking it, because it persists the secret.
//
// So credentials are handled before identifier masking, and their replacement
// is one-way: the token is never written to the map, so restore() cannot bring
// the secret back. A developer who sees __REDACTED_AWS_KEY_1__ in their restored
// code has been told, unmistakably, that a live key was in the payload.
import { assertKnownOptions, optionKeys } from './options.js';
import { lineIndex, positionOf } from './lines.js';
import { LANGUAGES } from './languages.js';
// ─── Structural validators ───────────────────────────────────────────────────
//
// Every one of these is arithmetic over the value itself. Nothing here infers,
// models, or consults a list of real-world numbers — which is what lets the
// engine keep its zero-dependency promise while still catching the material the
// tool is most often reached for.
/** Digits only, separators removed. */
function digitsOf(value) {
    return value.replace(/[^0-9]/g, '');
}
/** Luhn (mod-10). Payment cards, and a good many national IDs. */
export function luhnValid(value) {
    const digits = digitsOf(value);
    if (digits.length < 12)
        return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (double) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}
/**
 * IBAN mod-97 (ISO 13616). Move the first four characters to the end, map
 * letters to two-digit numbers, and the whole thing mod 97 must be 1.
 *
 * Computed in chunks because the expanded number can exceed 2^53 — doing it in
 * one `Number()` silently loses precision and starts accepting invalid IBANs,
 * which is worse than not checking at all.
 */
export function ibanValid(value) {
    const compact = value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact))
        return false;
    const rearranged = compact.slice(4) + compact.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
        const mapped = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
        for (const digit of mapped) {
            remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
        }
    }
    return remainder === 1;
}
/**
 * PESEL — the Polish national identification number.
 *
 * Eleven digits: a date, a serial, and a weighted check digit. The date is
 * checked as well as the checksum, because eleven digits is a common enough
 * shape in source that the check digit alone leaves too many coincidences.
 */
export function peselValid(value) {
    const digits = digitsOf(value);
    if (digits.length !== 11)
        return false;
    const weights = [9, 7, 3, 1, 9, 7, 3, 1, 9, 7];
    let sum = 0;
    for (let i = 0; i < 10; i++)
        sum += (digits.charCodeAt(i) - 48) * weights[i];
    if (sum % 10 !== digits.charCodeAt(10) - 48)
        return false;
    // Century is encoded in the month field, which is what makes an arbitrary
    // eleven-digit run overwhelmingly likely to fail here even when the checksum
    // happens to pass.
    const monthField = Number(digits.slice(2, 4));
    const century = Math.floor(monthField / 20);
    const month = monthField % 20;
    if (century > 4 || month < 1 || month > 12)
        return false;
    const day = Number(digits.slice(4, 6));
    if (day < 1 || day > 31)
        return false;
    return true;
}
/**
 * Card numbers that appear in every payments fixture and documentation page.
 *
 * Luhn-valid by construction, so the checksum cannot separate them from a real
 * card. Reporting them on every file is the crying-wolf failure the advisory
 * panel work exists to remove — the finding that mattered ends up in the same
 * grey list as ninety that did not.
 */
const KNOWN_TEST_PANS = new Set([
    '4111111111111111',
    '4012888888881881',
    '4222222222222',
    '4242424242424242',
    '4000056655665556',
    '5555555555554444',
    '5105105105105100',
    '2223003122003222',
    '378282246310005',
    '371449635398431',
    '6011111111111117',
    '6011000990139424',
    '3056930009020004',
    '3566002020360505',
]);
/** Issuer prefixes we recognise. A Luhn-valid digit run that begins with none
 *  of these is far more likely to be an identifier than a card. */
function looksLikePan(value) {
    const digits = digitsOf(value);
    if (digits.length < 13 || digits.length > 19)
        return false;
    if (KNOWN_TEST_PANS.has(digits))
        return false;
    const iin = /^4/.test(digits) ||
        /^5[1-5]/.test(digits) ||
        /^2[2-7]/.test(digits) ||
        /^3[47]/.test(digits) ||
        /^6(?:011|5)/.test(digits) ||
        /^3(?:0[0-5]|[68])/.test(digits);
    return iin && luhnValid(digits);
}
/** Decode standard base64 without relying on `atob` (not in every runtime the
 *  engine supports, and not in its ES2022 type surface). Null when the input
 *  is not base64. */
function decodeBase64(value) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const body = value.replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(body) || body.length % 4 === 1)
        return null;
    let bits = 0;
    let acc = 0;
    let out = '';
    for (const ch of body) {
        acc = (acc << 6) | alphabet.indexOf(ch);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((acc >> bits) & 0xff);
        }
    }
    return out;
}
/** HTTP Basic credentials decode to `user:password` in printable text. A word
 *  that happens to be base64 (`Authorization: Basic auth`) decodes to bytes. */
function basicCredentials(value) {
    const decoded = decodeBase64(value);
    return decoded !== null && decoded.includes(':') && /^[\x20-\x7e]+$/.test(decoded);
}
/** Whether Basic credentials stay redacted in a test or example file. Half by
 *  half, never the joined string (code review of #166, rulings 2 and 3): a
 *  provider-format key anywhere in the decoded payload, a token-shaped user
 *  half, or a strong password half. */
function basicKept(value) {
    const decoded = decodeBase64(value);
    if (decoded === null || !decoded.includes(':'))
        return isStrong(value);
    const colon = decoded.indexOf(':');
    return (holdsProviderKey(decoded) ||
        isTokenShaped(decoded.slice(0, colon)) ||
        isStrong(decoded.slice(colon + 1)));
}
/** The engine's high-entropy token test, as the catch-all rule below applies
 *  it: 24 to 200 token characters, entropy over the assignment floor. */
function isHighEntropyToken(value) {
    return /^[A-Za-z0-9+/_-]{24,200}={0,2}$/.test(value) && shannonEntropy(value) >= ENTROPY_FLOOR;
}
/** One part of a path or of a compound name: a word in lower, camel or upper
 *  case with at most four digits after a word, or a short number (`auth`,
 *  `personalMaps`, `v2`, `sha256Digest`, `MAX`, `2026`). Each character is
 *  read once: the alternatives start on different characters. */
const WORDY_PART = /^(?:[A-Za-z]?[a-z]+(?:[0-9]{1,4}(?=[A-Z]|$)|[A-Z][a-z]+)*|[A-Z]{2,}[0-9]{0,4}|[0-9]{1,4})$/;
/** A high-entropy token that nothing reads as ordinary text: it holds a
 *  digit, and it is not words joined by `/`, `-` or `_` (a route, a path, a
 *  compound name). Anything else of the shape is left to masking: hidden from
 *  the model, and restorable. */
function isTokenValue(value) {
    return (isHighEntropyToken(value) &&
        /[0-9]/.test(value) &&
        !value
            .split(/[/_+=-]+/)
            .filter(Boolean)
            .every((part) => WORDY_PART.test(part)));
}
/** A value that reads as a token, not as the next word of a sentence: it
 *  holds a digit, or is 20 characters or longer. */
function isLikelyToken(value) {
    return /[0-9]/.test(value) || value.length >= 20;
}
/** A user half that is a token rather than a name: a high-entropy token.
 *  Never `isStrong`: `Build-Agent01` is a name. A provider-format key as the
 *  user is the other half of the ruling, and needs no test here: in a URL or
 *  on a command line its own rule finds it in clear, and in Basic credentials
 *  `basicKept` runs the provider rules over the decoded payload. */
function isTokenShaped(value) {
    return isHighEntropyToken(value);
}
/** A header value that is code, not a literal: it starts at a known code
 *  root (an environment lookup, a config object, a template variable). A
 *  dotted or bracketed literal is not code (`abc.def`), and a JWT - three
 *  base64url parts, the first a JSON header - is always a credential (second
 *  security review). */
function isCodeExpression(value) {
    if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value))
        return false;
    return /^(?:process\.env\.|os\.environ|os\.getenv\(|ENV\[|config\.|settings\.|secrets\.|import\.meta\.env\.|\$|\{\{)/.test(value);
}
/** `${NAME:-default}`, `${NAME-default}`, `${NAME:=default}`, and Spring's
 *  `${NAME:default}`: the default is the value (finding 10). `${NAME}` and
 *  `${NAME:?message}` stay placeholders. */
const WITH_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_.]*(?::?[-=]|:(?![?+]))([^}]*)\}$/;
// Values in a secret position: double-quoted, single-quoted, or bare. A bare
// value ends at whitespace, a quote or a shell separator, but a `${...}` in it
// is taken whole, spaces included, so its default can be judged
// (`${PG:-two words}`, code review of #166 round 3, finding 2). A templating
// placeholder that spans spaces (`${{ secrets.X }}`, `{{ x }}`, `<your
// password>`) is matched whole and captures nothing - only when it is the whole
// value: one with more characters after it is judged as a value (finding 7).
const VALUE_END = '(?=[\\s"\'`;&|]|$)';
const PH = `(?:\\$?\\{\\{[^}\\n]{0,200}\\}\\}|<[^<>\\n]{1,100}>)${VALUE_END}`;
const DQ = '"([^"\\n]{0,256})"';
const SQ = "'([^'\\n]{0,256})'";
/** One character of a bare value, or a whole `${...}`. The alternatives start
 *  on different characters, so the repetition stays linear. */
const BARE_UNIT = '(?:\\$\\{[^}\\n]{0,200}\\}|[^\\s"\'`;&|$]|\\$(?!\\{[^}\\n]{0,200}\\}))';
const BARE = `((?:${BARE_UNIT}){1,256})`;
/** One shell word: bare units and quoted segments glued together
 *  (`abc"def ghi"` is one word). Linear: each alternative starts on its own
 *  character. */
const SHELL_WORD = `((?:${BARE_UNIT}|"[^"\\n]*"|'[^'\\n]*')+)`;
/** A dotenv or YAML value: the rest of the line. A ` #` (whitespace, then #)
 *  starts a comment, after an empty value too (`DB_PASSWORD= # later`); a `#`
 *  glued to the value, or right after the `=`, is part of it; trailing spaces
 *  are not. Linear: a run of spaces is consumed once and checked once. */
const LINE_VALUE = `((?!["'])(?:[^\\s#]|(?<![ \\t])#)(?:[^\\s]|[ \\t]+(?=[^\\s#]))*)`;
// After a separating space a bare value that starts with `-` is the next flag.
const BARE_ARG = `((?!-)(?:${BARE_UNIT}){1,256})`;
/** A command word: the name standing alone, then whitespace or a quote. */
const command = (names) => `(?<![\\w.-])(?:${names})(?:\\.exe)?(?=[\\s"'])`;
/** The rest of the command, bounded so a scan stays linear. A backslash at
 *  the end of a line continues it (finding 8). */
const WINDOW = '(?:[^\\n;&|\\\\]|\\\\\\r?\\n|\\\\[^\\n]){0,300}?';
const SAME_LINE = `${WINDOW}[ \\t]`;
/** Between a command word and its flag inside an argv array, where black and
 *  prettier put each element on its own line (1.12.1 review): quoted elements,
 *  commas and whitespace only, bounded. */
const ARGV_WINDOW = '["\']?(?:[\\s,[(]{1,20}["\'][^"\'\\n]{0,100}["\']){0,20}[\\s,[(]{1,20}';
/** The argv-array form of a flag: `"-pVALUE"`, or with `separated` also the
 *  flag and its value as two elements, `"-p", "VALUE"` (round 3, finding 4). */
const argvFlag = (flag, separated) => `(?:${WINDOW}|${ARGV_WINDOW})["']${flag}(?:${BARE}${separated ? `|["']\\s*,\\s*(?:${DQ}|${SQ})` : ''})`;
/** A short flag with its value attached only. */
const attachedFlag = (flag) => `${flag}(?:${PH}|${DQ}|${SQ}|${BARE})`;
/** A short flag with its value attached or after spaces. */
const shortFlag = (flag) => `${flag}(?:${PH}|${DQ}|${SQ}|${BARE}|[ \\t]+(?:${PH}|${DQ}|${SQ}|${BARE_ARG}))`;
/** A program's own options before its subcommand: at most four, each with
 *  its value after `=` or as the next word (`docker --config /tmp/c login`). */
const GLOBAL_OPTIONS = '(?:[ \\t]+--?[\\w-]{1,40}(?:=[^\\s;&|]{0,200}|[ \\t]+[^\\s;&|-][^\\s;&|]{0,200})?){0,4}';
/** To the next word of a command line, or the next element of an argv array. */
const NEXT_WORD = '(?:[ \\t]+|["\']\\s{0,20},\\s{0,20}["\'])';
// research R1. `-p` is the password only for these clients; for psql, ssh,
// redis-cli and docker it is a port. For mysql and mariadb only the attached
// form is: `-p shop` prompts for the password and opens database `shop`.
const MYSQL_CLIENTS = 'mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mysqlbinlog|' +
    'mariadb(?:-dump|-admin|-import|-check|-show)?';
// These take `-p <password>` with a space as well.
const SEPARATED_P_CLIENTS = 'mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport|sshpass';
// `-P` is the password for these; for mysql it is the port.
const DASH_CAP_P_TOOLS = 'sqlcmd|bcp|osql|isql|ipmitool';
// research R2. Exact names; `*_FILE` variants hold paths and are not listed.
/** Spec 013 R17: the credential words an environment-style name ends in -
 *  one list, so the suffix and the standalone forms cannot drift apart. */
const CREDENTIAL_WORDS = [
    'PASSWORD',
    'PASSWD',
    'PASSPHRASE',
    'SECRET',
    'SECRET_KEY',
    'API_KEY',
    'APIKEY',
    'ACCESS_KEY',
    'PRIVATE_KEY',
    'ENCRYPTION_KEY',
    'SIGNING_KEY',
    'JWT_KEY',
    'TOKEN',
    'ACCESS_TOKEN',
    'AUTH_TOKEN',
    'REFRESH_TOKEN',
    'CLIENT_SECRET',
].join('|');
/** A name that is, or ends in, a credential word. `PWD` and `PASS` count only
 *  as a suffix (`DB_PWD`, `SMTP_PASS`): alone they are a directory and a flag.
 *  Linear: `^` anchors each attempt to a line start, and the run is read once. */
const ENV_CREDENTIAL_NAME = `(?:[A-Z][A-Z0-9_]*_(?:PWD|PASS)|(?:[A-Z][A-Z0-9_]*_)?(?:${CREDENTIAL_WORDS}))`;
const PASSWORD_ENV = 'PGPASSWORD|MYSQL_PWD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MARIADB_ROOT_PASSWORD|' +
    'MARIADB_PASSWORD|POSTGRES_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|RABBITMQ_DEFAULT_PASS|' +
    'MSSQL_SA_PASSWORD|SA_PASSWORD|SQLCMDPASSWORD|REDISCLI_AUTH|SSHPASS|ELASTIC_PASSWORD|' +
    'KEYCLOAK_ADMIN_PASSWORD|KC_BOOTSTRAP_ADMIN_PASSWORD|RESTIC_PASSWORD|BORG_PASSPHRASE';
/** Groups 1-6 of a `shortFlag`, then 7-9 of its `argvFlag(flag, true)`. */
const FLAG_GROUPS = [1, 2, 3, 4, 5, 6];
const ARGV_GROUPS = [7, 8, 9];
/**
 * A value after `--password` that reads as help text or prose, in any file and
 * with no path (code review of #166, round 3): one of a closed list of
 * metavars, a bracketed metavar, or a common prose word (`to`, `in`, `the`, …;
 * 1.12.1 review). Any other value is a password - `--password hunter2` in a
 * README too.
 */
function proseValue(value) {
    return (/^(?:PASSWORD|PASS|PASSWD|PWD|TEXT|VALUE|SECRET|STRING|TOKEN|KEY)$/.test(value) ||
        /^\[[^\]]*\]$/.test(value) ||
        /^(?:to|for|is|in|and|or|on|with|when|if|as|of|the|a|an|that|this|from)$/.test(value));
}
// Patterns are written to be linear-time: no nested quantifiers over the same
// character class, and bounded repetition wherever the input is attacker-shaped.
/**
 * Spec 013 R17: credentials assigned to environment-style names, in the file
 * kinds whose grammar is unambiguous - dotenv, YAML and shell - and nowhere
 * else: with no path, in source code or in prose the engine behaves as 1.12.1
 * did (research R17, R18). Fixed names (R2's list) are a secret position,
 * destroyed; convention names are judged like the generic assignment rule.
 */
/** A block indicator alone is never a value (`|`, `>-`, `|2`), for R2's
 *  fixed names too: anything else after them, `!` or `*` first included, is. */
const notBlockIndicator = (value) => !/^[|>](?:[1-9][-+]?|[-+][1-9]?)?$/.test(value);
/** In a YAML file, YAML syntax is never a value: a block indicator, an alias,
 *  or a bare tag or anchor. A tag or anchor before a value is stepped over by
 *  the rule (YAML_PROPS) and the value after it judged. */
const notYamlSyntax = (value) => notBlockIndicator(value) && !/^(?:\*\S+|&\S+|!\S*)$/.test(value);
const YAML_PROPS = '(?:(?:&[^\\s]+|![^\\s]*)[ \\t]+)*';
/** A unified-diff line's first character (`+`, `-`, a space), so a patch reads
 *  as the lines it holds: `+DB_PASSWORD=…` is an assignment too. Only adds. */
const DIFF = '[+\\- ]?';
/** Quoted values in the new rules (security reviews of 11f2d20, 1bde3ab,
 *  2bc28d4, 123730b and the review of f26b887): up to 16 KB, a double-quoted
 *  one honouring backslash escapes, a YAML single-quoted one `''`. A closed
 *  quote may span lines, as dotenv and YAML allow, but never past a line that
 *  starts a new assignment (`NAME=`, `key:`, any accepted prefix): a quote
 *  that does not close before one, or within 16 KB, takes the rest of its own
 *  line instead, so a stray quote never destroys the next keys. A multi-line
 *  value past 16 KB is read to the end of its first line (research R18).
 *  Linear: each alternative starts on its own character. */
const NEXT_LINE = '\\n(?![ \\t]*[-+]?[ \\t]*(?:(?:export|set|ENV|ARG|readonly|local|declare[ \\t]+-x)[ \\t]+)?["\']?[A-Za-z_][\\w.-]*["\']?[ \\t]*[=:])';
const ENV_DQ = `"((?:[^"\\\\\\n]|\\\\.|${NEXT_LINE}){0,16384})"`;
const ENV_SQ = `'((?:[^'\\n]|${NEXT_LINE}){0,16384})'`;
const YAML_DQ = ENV_DQ;
const YAML_SQ = `'((?:[^'\\n]|''|${NEXT_LINE}){0,16384})'`;
const UNCLOSED = '(["\'][^\\n]*)';
/** A convention name's value that is not a credential (review of f26b887): a
 *  file path or a reference to one (`./keys/jwt.pem`, `~/.ssh/id`,
 *  `$HOME/key.asc`, `${PWD}/certs/sign.pem`); a shell command substitution
 *  (`"$(openssl rand …)"`, a backtick); or, as the quoted generic rule reads
 *  it, a value under 6 characters (`true`, `4096`, `on`, `~`). */
function conventionValue(value) {
    const v = value.replace(/^["']/, '');
    if (/^(?:\$\(|`)/.test(v))
        return false;
    // A path reads as one: two or more clean segments, or a key file's extension.
    if (/^(?:~|\.{1,2}|\$\{?[A-Za-z_]\w*\}?|[A-Za-z]:)?(?:[\\/][\w.-]+){2,}[\\/]?$/.test(v) ||
        /^(?:~|\.{1,2}|\$\{?[A-Za-z_]\w*\}?|[A-Za-z]:)?(?:[\\/][\w.-]+)+\.(?:pem|key|asc|p12|pfx|crt|der|jks|keystore|pub|json)$/i.test(v))
        return false;
    return value.length >= 6;
}
function envRules() {
    const classes = [
        { names: PASSWORD_ENV, fixed: true },
        { names: ENV_CREDENTIAL_NAME, fixed: false },
    ];
    const rules = [];
    for (const { names, fixed } of classes) {
        const base = {
            type: 'password-assignment',
            disposition: 'destroy',
            severity: 'medium',
            label: fixed
                ? 'Password in an environment variable'
                : 'Credential in an environment variable',
            ...(fixed ? { position: true } : {}),
        };
        // Fixed names: a credential whatever the value. Convention names: judged.
        const value = (v) => fixed || conventionValue(v);
        // dotenv: NAME=v, NAME = v, optional export - the rest of the line.
        // Convention names in any case there (dotenv keys are not always upper case).
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*(?:export[ \\t]+)?["']?(?:${names})["']?[ \\t]*=[ \\t]*(?:${PH}|${ENV_DQ}|${ENV_SQ}|${LINE_VALUE}|${UNCLOSED})`, fixed ? 'gm' : 'gmi'),
            groups: [1, 2, 3, 4],
            only: (scan) => scan.dotenv,
            validate: (v) => value(v),
        });
        // YAML: NAME: v - the rest of the line, never YAML syntax.
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*(?:-[ \\t]+)?["']?(?:${names})["']?[ \\t]*:[ \\t]*${YAML_PROPS}(?:${PH}|${YAML_DQ}|${YAML_SQ}|${LINE_VALUE}|${UNCLOSED})`, 'gm'),
            groups: [1, 2, 3, 4],
            only: (scan) => scan.yaml,
            validate: (v, group) => (group !== 3 || notYamlSyntax(v)) && value(v),
        });
        // YAML compose list: - NAME=v, - "NAME=v", - 'NAME=v' (the quote kept).
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*-[ \\t]+(?:"(?:${names})=([^"\\n]+)"|'(?:${names})=([^'\\n]+)'|(?:${names})=(?:${PH}|${LINE_VALUE})|["'](?:${names})=([^\\n]+))`, 'gm'),
            groups: [1, 2, 3, 4],
            only: (scan) => scan.yaml,
            validate: (v) => value(v),
        });
        // shell and Dockerfile: NAME=v after export, ENV and the like, one shell
        // word of any length. Fixed names too: R2's own rule keeps 1.12.1's
        // 256-character grammar for text with no file kind.
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*(?:(?:export|declare[ \\t]+-x|readonly|local|ENV|ARG)[ \\t]+)?(?:${names})=(?:${PH}|${DQ}(?=[\\s;&|]|$)|${SQ}(?=[\\s;&|]|$)|${SHELL_WORD})`, 'gm'),
            groups: [1, 2, 3],
            only: (scan) => scan.shell,
            validate: (v) => value(v),
        });
    }
    return rules;
}
const ENV_RULES = envRules();
const PATTERNS = [
    {
        type: 'private-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Private key block',
        re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    },
    {
        type: 'aws-access-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'AWS access key ID',
        re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    },
    {
        type: 'aws-secret-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'AWS secret access key',
        re: /(?:aws_secret_access_key|aws_secret_key|awsSecretKey)["'\s:=]{1,10}([A-Za-z0-9/+=]{40})/gi,
        group: 1,
    },
    {
        type: 'stripe-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Stripe secret key',
        re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,247}\b/g,
    },
    {
        type: 'github-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'GitHub token',
        re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    },
    {
        type: 'slack-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Slack token',
        re: /\bxox[baprse]-[A-Za-z0-9-]{10,250}\b/g,
    },
    {
        type: 'anthropic-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Anthropic API key',
        re: /\bsk-ant-[A-Za-z0-9_-]{20,250}\b/g,
    },
    {
        // `sk-ant-` is excluded so an Anthropic key is reported as one rather than
        // racing the OpenAI pattern for the identical span.
        type: 'openai-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'OpenAI API key',
        re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}\b/g,
    },
    {
        type: 'google-api-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Google API key',
        re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
        type: 'npm-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'npm access token',
        re: /\bnpm_[A-Za-z0-9]{36}\b/g,
    },
    {
        type: 'gitlab-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'GitLab token',
        re: /\bglpat-[A-Za-z0-9_-]{20,50}\b/g,
    },
    {
        type: 'slack-webhook',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Slack webhook URL',
        re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_-]{6,20}\/B[A-Za-z0-9_-]{6,20}\/[A-Za-z0-9_-]{20,30}/g,
    },
    {
        type: 'discord-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Discord bot token',
        re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g,
    },
    {
        type: 'gcp-service-account',
        disposition: 'destroy',
        severity: 'critical',
        label: 'GCP service-account key',
        re: /"type"\s*:\s*"service_account"[\s\S]{0,400}?"private_key_id"\s*:\s*"([a-f0-9]{40})"/g,
        group: 1,
    },
    {
        type: 'azure-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Azure storage key',
        re: /\bAccountKey\s*=\s*([A-Za-z0-9+/]{86}==)/g,
        group: 1,
    },
    {
        type: 'pypi-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'PyPI upload token',
        re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g,
    },
    {
        type: 'sendgrid-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'SendGrid API key',
        re: /\bSG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{39,50}\b/g,
    },
    {
        type: 'twilio-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Twilio account SID',
        re: /\bAC[a-f0-9]{32}\b/g,
    },
    {
        type: 'mailgun-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Mailgun API key',
        re: /\bkey-[a-f0-9]{32}\b/g,
    },
    {
        type: 'datadog-key',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Datadog API key',
        re: /(?:datadog|dd)[_-]?api[_-]?key["'\s:=]{1,10}([a-f0-9]{32})\b/gi,
        group: 1,
    },
    {
        type: 'hugging-face-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Hugging Face token',
        re: /\bhf_[A-Za-z0-9]{34,40}\b/g,
    },
    {
        type: 'supabase-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Supabase service key',
        re: /\bsbp_[a-f0-9]{40}\b/g,
    },
    {
        type: 'square-token',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Square access token',
        re: /\b(?:sq0atp|sq0csp|EAAA)[A-Za-z0-9_-]{22,60}\b/g,
    },
    {
        type: 'shopify-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Shopify access token',
        re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
    },
    {
        type: 'cloudflare-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Cloudflare API token',
        re: /(?:cloudflare|cf)[_-]?api[_-]?(?:token|key)["'\s:=]{1,10}([A-Za-z0-9_-]{37,45})\b/gi,
        group: 1,
    },
    // ─── Formats checked against each vendor's own documentation ─────────────
    //
    // A rule is added only for a format its vendor states, and is anchored on
    // what the vendor states: where only the prefix is documented, the body is a
    // run of token characters of a least length chosen here (said at the rule).
    // A second rule of a type keeps that type's severity: the grades are read
    // from this table by type.
    {
        // docs.github.com, "About authentication to GitHub", token formats: the
        // prefix of a fine-grained personal access token. No length is stated; a
        // digit is asked for, so a long name that starts the same way is not one.
        type: 'github-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'GitHub fine-grained token',
        re: /\bgithub_pat_(?=[A-Za-z_]{0,255}[0-9])[A-Za-z0-9_]{36,255}\b/g,
    },
    {
        // digitalocean.com/blog/updated-api-tokens-new-management-features: a
        // personal access token, an OAuth token, an OAuth refresh token. No length
        // is stated.
        type: 'digitalocean-token',
        disposition: 'destroy',
        severity: 'critical',
        label: 'DigitalOcean token',
        re: /\bdo[opr]_v1_[A-Za-z0-9]{32,255}\b/g,
    },
    {
        // twilio.com/docs/glossary/what-is-a-sid: two letters and 32 hexadecimal
        // digits; SK is an API key. It is the key's name, used with its secret.
        type: 'twilio-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Twilio API key SID',
        re: /\bSK[a-f0-9]{32}\b/g,
    },
    {
        // docs.stripe.com/webhooks: an endpoint's signing secret begins with this
        // prefix. No length is stated.
        type: 'stripe-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Stripe webhook secret',
        re: /\bwhsec_[A-Za-z0-9]{24,255}\b/g,
    },
    {
        // developers.google.com/identity/protocols/oauth2: the access tokens in
        // its examples begin with this prefix. No length is stated.
        type: 'google-api-key',
        disposition: 'destroy',
        severity: 'high',
        label: 'Google OAuth access token',
        re: /\bya29\.[A-Za-z0-9_.-]{20,2048}\b/g,
    },
    {
        // docs.sentry.io/security-legal-pii/security/token-formats: a personal
        // token is the prefix and 64 hexadecimal characters.
        type: 'sentry-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Sentry token',
        re: /\bsntryu_[a-f0-9]{64}\b/g,
    },
    {
        // The same page: an organisation token is the prefix, a base64 payload,
        // an underscore and 43 base64 characters.
        type: 'sentry-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Sentry token',
        re: /\bsntrys_[A-Za-z0-9+/=]{1,500}_[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])/g,
    },
    {
        // linear.app/changelog, "API improvements": the prefixes of an API key
        // and of an OAuth token. No length is stated.
        type: 'linear-key',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Linear API key',
        re: /\blin_(?:api|oauth)_[A-Za-z0-9]{32,255}\b/g,
    },
    {
        // developer.hashicorp.com/vault/docs/concepts/tokens: a service, batch or
        // recovery token is its prefix and 24 or more random characters. A digit
        // is asked for, so a member of an object called `hvs` is not a token. The
        // prefixes before Vault 1.10 (`s.`, `b.`, `r.`) are a letter and a dot:
        // not listed.
        type: 'vault-token',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Vault token',
        re: /\bhv[sbr]\.(?=[A-Za-z_-]{0,500}[0-9])[A-Za-z0-9_-]{24,500}\b/g,
    },
    {
        // github.com/C2SP/C2SP, age.md: an X25519 identity is 32 bytes in Bech32
        // under this prefix, 58 characters.
        type: 'age-secret-key',
        disposition: 'destroy',
        severity: 'critical',
        label: 'age secret key',
        re: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/g,
    },
    {
        // devcenter.heroku.com/changelog-items/2800 and 3176: an OAuth access
        // token has this prefix; 41 characters in all, 65 since April 2025.
        type: 'heroku-token',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Heroku token',
        re: /\bHRKU-[A-Za-z0-9_-]{36,255}\b/g,
    },
    {
        // docs.slack.dev/authentication/tokens: an app-level token and a
        // workflow token, by their prefixes; with a digit, so a dashed name
        // (`xapp-production-api`) is not one.
        type: 'slack-token',
        disposition: 'destroy',
        severity: 'high',
        label: 'Slack app-level token',
        re: /\bx(?:app|wfp)-(?=[A-Za-z-]{0,250}[0-9])[A-Za-z0-9-]{10,250}\b/g,
    },
    {
        type: 'basic-auth',
        disposition: 'destroy',
        severity: 'medium',
        label: 'HTTP Basic credentials',
        re: /\bBasic\s+([A-Za-z0-9+/]{16,400}={0,2})/g,
        group: 1,
        position: true,
        keep: basicKept,
    },
    {
        type: 'jwt',
        disposition: 'destroy',
        severity: 'medium',
        label: 'JSON Web Token',
        re: /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{0,2000}/g,
    },
    {
        type: 'bearer-token',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Bearer / Authorization token',
        re: /(?:Authorization["'\s:=]{1,10})?\bBearer\s+([A-Za-z0-9._~+/-]{16,500}=*)/g,
        group: 1,
        position: true,
    },
    // ─── Secret positions (spec 013) ──────────────────────────────────────────
    //
    // Slots that can only hold a credential, so the value is one whatever its
    // strength: a weak password is exactly what a person types here. The lists
    // and their sources are in research.md of spec 013. Every rule captures only
    // the value, so only the secret is replaced - never the flag, the variable,
    // the user or the host.
    {
        // In the header position a token is a token from 8 characters; on its own
        // (the rule above) a short word after Bearer is usually prose.
        type: 'bearer-token',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Bearer / Authorization token',
        re: /(?<![\w-])(?:Proxy-)?Authorization["'\s:=]{1,10}Bearer[ \t]+([A-Za-z0-9._~+/-]{8,500}=*)/gi,
        group: 1,
        position: true,
    },
    {
        type: 'basic-auth',
        disposition: 'destroy',
        severity: 'medium',
        label: 'HTTP Basic credentials',
        re: /(?<![\w-])(?:Proxy-)?Authorization["'\s:=]{1,10}Basic[ \t]+([A-Za-z0-9+/]{4,400}={0,2})/gi,
        group: 1,
        position: true,
        // `Authorization: Basic auth` is prose; real credentials decode to
        // printable `user:password`.
        validate: basicCredentials,
        keep: basicKept,
    },
    {
        // Any other scheme word (`token`, `ApiKey`, `Digest`, a vendor's own): the
        // value after it, in the header position only - a colon, an equals sign
        // or the comma of a call after the name. A plain word after the scheme
        // word is prose (`Authorization: Token authentication`); a variable has a
        // `$` or a brace and is not matched. Redacted in a test file too, as the
        // login commands below.
        type: 'bearer-token',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Bearer / Authorization token',
        re: /(?<![\w-])(?:Proxy-)?Authorization["']?[ \t]{0,3}[:=,][ \t]{0,3}["']?(?!Bearer[ \t]|Basic[ \t])[A-Za-z][A-Za-z0-9_-]{1,30}[ \t]+([A-Za-z0-9._~+/-]{8,500}=*)/gi,
        group: 1,
        position: true,
        keep: () => true,
        validate: isLikelyToken,
    },
    {
        // A raw header line or a curl -H argument takes a bare value; an entry in
        // a header map only a quoted literal, because a bare value there is a
        // variable. From 4 characters: no issued key is shorter, and a shorter
        // value after the header name is prose. (Described rather than
        // illustrated: an example header here would match this rule.)
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'API key header',
        re: new RegExp(`(?<![\\w-])X-Api-Key(?:[ \\t]{0,3}:[ \\t]{0,3}(?:${PH}|([^\\s"'\`;,]{4,500}))|["'][ \\t]{0,3}:[ \\t]{0,3}(?:"([^"\\n]{4,500})"|'([^'\\n]{4,500})'))`, 'gi'),
        groups: [1, 2, 3],
        position: true,
        // A member access or a call after the header name is code (finding 9).
        validate: (value) => !isCodeExpression(value),
    },
    {
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command(MYSQL_CLIENTS)}(?:${SAME_LINE}${attachedFlag('-p')}|${argvFlag('-p', false)})`, 'g'),
        groups: [1, 2, 3, 4],
        position: true,
    },
    {
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command(SEPARATED_P_CLIENTS)}(?:${SAME_LINE}${shortFlag('-p')}|${argvFlag('-p', true)})`, 'g'),
        groups: [...FLAG_GROUPS, ...ARGV_GROUPS],
        position: true,
    },
    {
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command(DASH_CAP_P_TOOLS)}(?:${SAME_LINE}${shortFlag('-P')}|${argvFlag('-P', true)})`, 'g'),
        groups: [...FLAG_GROUPS, ...ARGV_GROUPS],
        position: true,
    },
    {
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command('redis-cli')}(?:${SAME_LINE}${shortFlag('-a')}|${argvFlag('-a', true)})`, 'g'),
        groups: [...FLAG_GROUPS, ...ARGV_GROUPS],
        position: true,
    },
    // ─── Login commands ───────────────────────────────────────────────────────
    //
    // `-p` is a port for docker run, ssh and psql, so it is a password only
    // after the subcommand that logs in - the first word after the program and
    // its own options. Each position is the one the command's manual states
    // (docs.docker.com/reference/cli/docker/login, podman-login(1), nerdctl's
    // command reference, helm.sh/docs/helm/helm_registry_login, `az login` in
    // the Azure CLI reference, smbclient(1), developer.hashicorp.com/vault/docs/
    // commands/login, httpd.apache.org/docs/current/programs/htpasswd.html).
    // The value is redacted in a test or example file too: these rules are new,
    // and what they find was masked before, never shown.
    {
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`(?:${command('docker|podman|nerdctl|az')}${GLOBAL_OPTIONS}${NEXT_WORD}|${command('helm')}${GLOBAL_OPTIONS}${NEXT_WORD}registry${NEXT_WORD})login(?=[\\s"'])(?:${SAME_LINE}${shortFlag('-p')}|${argvFlag('-p', true)})`, 'g'),
        groups: [...FLAG_GROUPS, ...ARGV_GROUPS],
        position: true,
        keep: () => true,
        // A bare word after the flag may be the next word of a sentence.
        validate: (value, group) => group !== 6 || !proseValue(value),
    },
    {
        // A password written out and piped to a login that reads it from standard
        // input (`echo <password> | docker login --password-stdin`). A variable
        // in its place is kept.
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`(?<![\\w.-])(?:echo|printf)(?:[ \\t]+-[neE]{1,3})?(?:[ \\t]+["']%s(?:\\\\n)?["'])?[ \\t]+(?:${DQ}|${SQ}|${BARE})[ \\t]*\\|[^\\n|;&]{0,300}?[ \\t]--password-stdin(?![\\w-])`, 'dg'),
        groups: [1, 2, 3],
        position: true,
        keep: () => true,
    },
    {
        // smbclient -U [DOMAIN\]USERNAME[%PASSWORD]. The user is kept.
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command('smbclient')}${SAME_LINE}(?:-U[ \\t]*|--user(?:[ \\t]+|=))(?:"[^"%\\n]{1,128}%([^"\\n]{1,256})"|'[^'%\\n]{1,128}%([^'\\n]{1,256})'|[^\\s"'%]{1,128}%([^\\s"'\`;&|]{1,256}))`, 'g'),
        groups: [1, 2, 3],
        position: true,
        keep: () => true,
    },
    {
        // vault login [options] <token>. Options come first, a value after `=` or
        // after the option; `key=value` arguments belong to another method, and a
        // short plain word is the next word of a sentence.
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Token on a command line',
        re: new RegExp(`${command('vault')}[ \\t]+login(?:[ \\t]+-(?:method|path|format|field|address|namespace|ns)[ \\t]+[^\\s-][^\\s;&|]{0,200}|[ \\t]+-[\\w-]{1,40}=[^\\s;&|]{0,200}|[ \\t]+-(?!(?:method|path|format|field|address|namespace|ns)(?![\\w-]))[\\w-]{1,40}(?![\\w=-])){0,8}[ \\t]+(?:${DQ}|${SQ}|${BARE_ARG})(?=[\\s;&|]|$)`, 'g'),
        groups: [1, 2, 3],
        position: true,
        keep: () => true,
        validate: (value) => !value.includes('=') && isLikelyToken(value),
    },
    {
        // htpasswd -b [options] passwdfile username password, and -nb username
        // password: with `b` among its flags, the last of two or three words.
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command('htpasswd')}(?=(?:[ \\t]+-[A-Za-ac-z0-9]{1,12}(?:[ \\t]+[0-9]{1,6})?){0,6}[ \\t]+-[A-Za-z0-9]{0,12}b)(?:[ \\t]+-[A-Za-z0-9]{1,12}(?:[ \\t]+[0-9]{1,6})?){1,8}(?:[ \\t]+[^\\s"';&|-][^\\s"';&|]{0,256}){1,2}[ \\t]+(?:${DQ}|${SQ}|${BARE_ARG})(?=[ \\t]*(?:[;&|#]|$))`, 'gm'),
        groups: [1, 2, 3],
        position: true,
        keep: () => true,
    },
    {
        // Any command, but only on a command line (finding 5). The name must end
        // at `=` or a space, so --password-stdin and --password-file are not it
        // (nor --no-password, whose double dash comes before `no`).
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`--(?:password|passwd|pass)(?:=(?:${PH}|${DQ}|${SQ}|${BARE})|[ \\t]+(?:${PH}|${DQ}|${SQ}|${BARE_ARG})|["']\\s*,\\s*(?:${DQ}|${SQ}))`, 'g'),
        // The argv array form (the flag and its value as two quoted elements)
        // adds groups 7 and 8.
        groups: [...FLAG_GROUPS, 7, 8],
        position: true,
        // Only the bare value after a space (group 6) can be a metavar or a prose
        // word; `--password=KEY` and a quoted value are always judged (1.12.1
        // review).
        validate: (value, group) => group !== 6 || !proseValue(value),
    },
    {
        // curl only: `-u 1000:1000` is a uid:gid for docker. The user is kept.
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password on a command line',
        re: new RegExp(`${command('curl')}${SAME_LINE}(?:-u[ \\t]*|--user(?:[ \\t]+|=))(?:"[^":\\n]{0,128}:([^"\\n]{0,256})"|'[^':\\n]{0,128}:([^'\\n]{0,256})'|[^\\s"':]{1,128}:([^\\s"'\`;&|]{0,256}))`, 'g'),
        groups: [1, 2, 3],
        position: true,
    },
    {
        // The user of curl -u, when it is a token (provider-shaped or a
        // high-entropy token): redacted in every file. A name stays.
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Token on a command line',
        re: new RegExp(`${command('curl')}${SAME_LINE}(?:-u[ \\t]*|--user(?:[ \\t]+|=))["']?([^\\s"':]{1,256}):`, 'g'),
        group: 1,
        validate: isTokenShaped,
    },
    {
        // Shell, dotenv, compose and PowerShell forms. After `=` a space ends a
        // shell assignment (`PGPASSWORD= psql` sets it empty), so a bare value
        // must follow at once; a quoted one may follow spaces (`$env:X = "v"`).
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Password in an environment variable',
        re: new RegExp(`(?<![\\w])(?:${PASSWORD_ENV})(?:["']?[ \\t]{0,3}=[ \\t]{0,3}(?:${PH}|${DQ}|${SQ})|=(?:${PH}|${BARE})|["']?[ \\t]{0,3}:[ \\t]{0,3}(?:${PH}|${DQ}|${SQ}|${BARE}))`, 'g'),
        groups: [1, 2, 3, 4, 5, 6],
        position: true,
        // A bare YAML block indicator after `NAME:` is not the value (spec 013 R17);
        // a quoted or `=` value starting with `>` or `|` is, as on 1.12.1.
        validate: (value, group) => group !== 6 || notBlockIndicator(value),
    },
    ...ENV_RULES,
    {
        type: 'connection-string',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Connection string password',
        // The user may be empty: `redis://:password@host` is the Redis form.
        re: /\b[a-z][a-z0-9+.-]{2,20}:\/\/[^\s:@/]{0,128}:([^\s:@/]{1,256})@/gi,
        group: 1,
        position: true,
    },
    {
        // The user half of URL userinfo, when it is a token (`https://<token>@`,
        // provider-shaped or a high-entropy token): redacted in every file. A
        // name stays. The group is not the tail of the match, so its offset comes
        // from the `d` flag.
        type: 'connection-string',
        disposition: 'destroy',
        severity: 'critical',
        label: 'Token in URL userinfo',
        re: /\b[a-z][a-z0-9+.-]{2,20}:\/\/([^\s:@/]{1,256})(?::[^\s@/]{0,256})?@/dgi,
        group: 1,
        validate: isTokenShaped,
    },
    {
        type: 'password-assignment',
        disposition: 'destroy',
        severity: 'medium',
        label: 'Hardcoded credential',
        // No LEADING \b: underscores and letters are both word characters, so a
        // leading boundary never exists after a prefix. Assignments to
        // DB_PASSWORD, MY_API_KEY and userPassword were all missed while a bare
        // password assignment was caught. Those prefixed forms are the common ones
        // in application code and in .env-style config, so the boundary was
        // excluding the majority case.
        //
        // (Written without backtick-quoted examples on purpose: this rule reads a
        // backtick as a value delimiter, so the illustration would flag itself.)
        //
        // The TRAILING \b is what keeps this from over-matching: the keyword must
        // end at a non-word character, so `passwordless`, `passwordHash` and
        // `secretary` still do not match. An identifier that *ends* in `password`
        // or `secret` and is assigned a 6+ character literal is a credential
        // whatever precedes it.
        re: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token|encryption[_-]?key)\b["'\s]{0,6}[:=]{1,2}[>\s]{0,3}["'`]([^"'`\n]{6,256})["'`]/gi,
        group: 1,
    },
    {
        // Catch-all for providers with no dedicated pattern above. Restricted to
        // *assignment* context and gated on entropy, because a bare long token in
        // prose is far more often a hash, a UUID or a base64 blob than a live
        // credential — and a detector that cries wolf gets switched off.
        type: 'high-entropy-string',
        disposition: 'destroy',
        severity: 'medium',
        label: 'High-entropy credential',
        // The name is one run of word characters holding a keyword, checked by a
        // lookahead, so the run is read once. Written as two stars around the
        // keyword it backtracked over a long run for every keyword inside it: a
        // file of 50,000 redaction tokens took 78 s (guard follow-up review).
        re: /\b(?=[a-z0-9_]*?(?:key|token|secret|credential|auth|pass))[a-z0-9_]+\b["'\s:=]{1,10}["'`]([A-Za-z0-9+/_-]{24,200}={0,2})["'`]/gi,
        group: 1,
    },
    {
        // A password flag on a command no list above names: for most programs
        // `-p` is a port or a path, and neither is a high-entropy token.
        type: 'high-entropy-string',
        disposition: 'destroy',
        severity: 'medium',
        label: 'High-entropy credential',
        re: /(?<![\w-])-p[ \t]+(?:"([A-Za-z0-9+/_-]{24,200}={0,2})"|'([A-Za-z0-9+/_-]{24,200}={0,2})'|([A-Za-z0-9+/_-]{24,200}={0,2})(?=[\s;&|]|$))/gm,
        groups: [1, 2, 3],
        validate: isTokenValue,
    },
    {
        type: 'private-ip',
        disposition: 'report',
        severity: 'low',
        label: 'Private IP address',
        re: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    },
    {
        type: 'email',
        disposition: 'report',
        severity: 'low',
        label: 'Email address',
        re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g,
    },
    // ─── Regulated identifiers ────────────────────────────────────────────────
    //
    // Not credentials: material a regulation cares about. The engine masks
    // identifiers bound by a language's grammar, so `const iban = "GB29..."` had
    // its NAME masked and its VALUE passed through untouched — and this is the
    // material the tool is most often reached for.
    //
    // Structural only. Every one is confirmed by arithmetic over the value, never
    // by inference, because an ML dependency would cost the zero-dependency
    // guarantee that is the whole argument for pasting the output into a model.
    {
        type: 'iban',
        disposition: 'mask',
        severity: 'high',
        label: 'Bank account number (IBAN)',
        // Country, check digits, then the account portion, tolerating the spacing
        // IBANs are conventionally printed with. Bounded repetition: linear.
        re: /\b[A-Z]{2}[0-9]{2}(?:[ -]?[A-Z0-9]){11,30}\b/g,
        validate: ibanValid,
    },
    {
        type: 'payment-card',
        disposition: 'mask',
        severity: 'medium',
        label: 'Payment card number',
        // Deliberately loose, because the validator is the real rule: an issuer
        // prefix, a plausible length, and Luhn. Encoding that in a regex makes it
        // unreadable and no more correct.
        re: /\b[0-9](?:[ -]?[0-9]){11,18}\b/g,
        validate: looksLikePan,
    },
    {
        type: 'pesel',
        disposition: 'mask',
        severity: 'medium',
        label: 'National identification number (PESEL)',
        re: /\b[0-9]{11}\b/g,
        validate: peselValid,
    },
];
/**
 * Whether `value`, whole, is a regulated identifier of `type` as the scanner
 * finds one: the same pattern and the same checksum (spec 085 R2-6). What a
 * map may hold under `__IBAN__` and the like.
 */
export function isRegulatedValue(type, value) {
    const rule = PATTERNS.find((p) => p.type === type && p.disposition === 'mask');
    if (!rule)
        return false;
    const whole = new RegExp(`^(?:${rule.re.source})$`, rule.re.flags.replace('g', ''));
    return whole.test(value) && (rule.validate?.(value) ?? true);
}
/** The provider-format rules: a named key shape, destroyed, not one of the
 *  generic slot or catch-all rules. Copies without the global flag, so testing
 *  a string never moves the table's own `lastIndex`. */
let providerRules = null;
function holdsProviderKey(text) {
    providerRules ??= PATTERNS.filter((p) => p.disposition === 'destroy' && p.position !== true && !GENERIC_MATCHERS.has(p.type)).map((p) => new RegExp(p.re.source, p.re.flags.replace(/[gyd]/g, '')));
    return providerRules.some((re) => re.test(text));
}
/**
 * The grade each rule carries, derived from the table above rather than
 * restated. A second hand-written copy is one that drifts.
 *
 * Exported because a caller that renders findings has to rank and style them,
 * and the alternative is every caller hardcoding its own idea of which types
 * are alarming — which is how the grades stopped meaning anything the first time.
 */
export const SECRET_SEVERITIES = Object.freeze(PATTERNS.reduce((acc, p) => {
    acc[p.type] = p.severity;
    return acc;
}, 
// The ambiguous verdict has no pattern of its own: it is what a pattern
// becomes when the value could be prose.
{ 'possible-credential': 'medium' }));
/**
 * What is done with each type's value, derived from the rule table.
 *
 * Derived rather than restated, for the same reason `SECRET_SEVERITIES` above
 * is: a second hand-written copy is one that drifts. This feature exists
 * because two DOCUMENTS holding the same decision drifted apart for eleven
 * weeks with nothing forcing them into the same room; repeating that shape one
 * layer down would be a poor lesson to take from it.
 */
export const SECRET_DISPOSITIONS = Object.freeze(PATTERNS.reduce((acc, p) => {
    acc[p.type] = p.disposition;
    return acc;
}, 
// `possible-credential` has no pattern of its own — same as its severity
// above — so it is seeded here.
//
// It stays `report`, and it MUST NOT drift to `mask` on the reasoning that
// masking is now reversible. This is the AMBIGUOUS verdict: a value that
// might be a live credential and might be prose. Masking it would write a
// possible live credential into the map, which is the precise thing this
// module's opening argument forbids — and the ambiguity is exactly why we
// cannot know which one we just persisted. Blanking it is also wrong, for
// the reason the old deny-list gave: redaction is irreversible, so
// destroying `client_secret: "disabled"` corrupts code restore() can never
// repair. Reporting it is the only honest answer to "we are not sure".
{ 'possible-credential': 'report' }));
/** Placeholder values that look like credentials but carry no secret. Redacting
 *  these is pure noise, and noisy warnings are the fastest way to teach a user
 *  to ignore the panel that matters. */
const KNOWN_DUMMY = new Set([
    'password',
    'changeme',
    'secret',
    'example',
    'placeholder',
    'your-api-key',
    'yourapikey',
    'xxxxxxxx',
    'redacted',
    'todo',
    'none',
    'null',
    'undefined',
    'test',
    'dummy',
    'sample',
    'foobar',
    'hunter2',
    '********',
    '<password>',
    'your_password_here',
    'my-secret',
    'supersecret',
    'notarealkey',
    // HTML `autocomplete` tokens. `autoComplete={... ? 'new-password' :
    // 'current-password'}` appears in essentially every login form, and the
    // assignment pattern reads the attribute value as a credential. Fixed strings
    // from the HTML spec, so suppressing them costs no detection.
    'current-password',
    'new-password',
    'one-time-code',
]);
function classifyValue(value, assignmentShaped) {
    const trimmed = value.trim();
    // A value that is nothing but redaction tokens carries no secret: it is what
    // a redaction already left (guard follow-up d03a). The guard scans a result
    // it redacted once more before sending it, and read the token as a
    // credential, withholding every result from a file of sample credentials.
    // Only whole tokens of this module's own kinds count, and only when nothing
    // else is left: a residue next to a token is part of a longer secret, and a
    // symbol-map placeholder may stand for a project name inside a credential,
    // so both are judged as before (review of 9d3f6d0).
    // Nothing at all: `PGPASSWORD=`, `-p''`, `curl -u admin:`.
    if (trimmed === '')
        return 'placeholder';
    if (trimmed.replace(REDACTION_TOKENS, '') === '')
        return 'placeholder';
    if (KNOWN_DUMMY.has(trimmed.toLowerCase()))
        return 'placeholder';
    // Templating placeholders: ${VAR}, {{var}}, %s, $VAR, <VALUE>. Matched
    // case-insensitively against the ORIGINAL — lowercasing first would stop
    // `$DB_PASSWORD` matching an upper-case-only shell-variable pattern.
    if (/^\$\{\{[^}]*\}\}$|^\$\{[^}]*\}$|^\{\{[^}]*\}\}$|^%[sdv]$|^\$[a-z_][a-z0-9_]*$|^<[^>]*>$/i.test(trimmed)) {
        return 'placeholder';
    }
    // Windows `%VAR%`, and a command substitution that reads the secret from
    // somewhere else (`$(cat /run/secrets/pw)`, or a backtick form).
    if (/^%[a-z_][a-z0-9_]*%$/i.test(trimmed) || /^\$\(|^`/.test(trimmed))
        return 'placeholder';
    // A run of one repeated character conveys nothing.
    if (/^(.)\1{3,}$/.test(trimmed))
        return 'placeholder';
    // Masked-out samples: `xxx`, `***`, `xxxx-xxxx-xxxx`, `[REDACTED]`.
    if (/^[x*•]{3,}(?:[-_ ][x*•]{3,})*$/i.test(trimmed))
        return 'placeholder';
    if (/^\[redacted\]$/i.test(trimmed))
        return 'placeholder';
    // An ellipsis stands for a value left out.
    if (/^(?:…|\.{3})$/.test(trimmed))
        return 'placeholder';
    // Everything below is a guess about prose, and prose is only a plausible
    // reading where the value could have been an enum or a mode. A connection
    // string or an Authorization header puts its value in a slot that is
    // structurally a credential: nothing but a password can legitimately sit
    // between the colon and the @ of a database URL. Those keep the pattern's own
    // severity — applying the prose heuristic to them silently dropped real
    // database passwords and bearer tokens for no reason beyond their being
    // lower-case. (Spelled out rather than illustrated: a working example URL in
    // this comment would match the rule it describes.)
    if (!assignmentShaped)
        return 'credential';
    // A single run of lowercase letters is usually a word: `client_secret:
    // "disabled"` is configuration, not a secret. But `password = "correcthorse"`
    // has the identical shape, so this reports rather than decides.
    if (/^[a-z]+$/.test(trimmed))
        return 'ambiguous';
    return 'credential';
}
/** Shannon entropy in bits per character. */
export function shannonEntropy(value) {
    if (value.length === 0)
        return 0;
    const counts = new Map();
    for (const ch of value)
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
/** Below this, an assignment value is more likely a sentence or a path than a
 *  credential. Real tokens are near-uniform over their alphabet. */
const ENTROPY_FLOOR = 2.6;
/**
 * Whether a value in a secret position is strong (spec 013, research R7):
 * long and mixed, or long and near-uniform. Anything else is weak, and a weak
 * value is only reported in a test, fixture or example file. Errs towards
 * strong: a value just over the line is redacted in tests too.
 */
function isStrong(value) {
    const entropy = shannonEntropy(value);
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((c) => c.test(value)).length;
    return ((value.length >= 12 && classes >= 3 && entropy >= 3) || (value.length >= 20 && entropy >= 3.3));
}
// research R6. Whole path segments and whole file-name shapes, so
// `src/attestation.ts` or `latest/config.ts` is real source.
const EXAMPLE_DIRS = new Set([
    'test',
    'tests',
    '__tests__',
    'spec',
    'specs',
    '__specs__',
    'fixtures',
    'fixture',
    '__fixtures__',
    'testdata',
    'test-data',
    'test_data',
    '__mocks__',
    'mocks',
    'examples',
    'example',
    'samples',
    'sample',
    'e2e',
]);
// `.env.example`, `.env.sample`, `.env.template` and `.env.dist` are taken by
// the suffix shapes below.
const EXAMPLE_FILES = new Set([
    'conftest.py',
    '.env.test',
    '.env.testing',
    '.env.ci',
]);
const EXAMPLE_FILE_SHAPE = /\.(?:test|spec)\.[^/]+$|_test\.[^/.]+$|^test_[^/]*\.py$|_spec\.rb$|\.(?:example|sample|template|dist|tpl)$/;
/**
 * Whether `path` names a test, fixture or example file (spec 013, decision 6).
 * There a weak value in a secret position is a fixture, and destroying it
 * would corrupt the test for no safety gain, so it is reported instead.
 */
export function isExamplePath(path, root) {
    const parts = projectPart(path, root).toLowerCase().split('/').filter(Boolean);
    const file = parts.pop();
    if (file === undefined)
        return false;
    if (parts.some((dir) => EXAMPLE_DIRS.has(dir)))
        return true;
    return EXAMPLE_FILES.has(file) || EXAMPLE_FILE_SHAPE.test(file);
}
/**
 * The part of `path` inside the project, `/`-separated (finding 6). A relative
 * path is taken as relative to the project. An absolute one is cut at `root`;
 * without a root, or outside it, only its file name counts: the engine reads
 * no filesystem, so it cannot find the project's `.git`, and a folder above
 * the project (`/home/test/...`) must never make real source a fixture.
 */
function projectPart(path, root) {
    const p = path.replace(/\\/g, '/');
    if (!/^(?:\/|[A-Za-z]:\/)/.test(p))
        return p;
    const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (base !== undefined && base !== '' && p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
        return p.slice(base.length + 1);
    }
    return p.slice(p.lastIndexOf('/') + 1);
}
/** Show enough of the value to be recognisable, never enough to be usable. */
export function previewSecret(value) {
    const clean = value.replace(/\s+/g, ' ').trim();
    // Spec 078 FR-017: no leading characters - a key's prefix plus its last
    // four halved a short password. 12 or fewer: the length only.
    if (clean.length <= 12)
        return `•••• (${clean.length} chars)`;
    return `…${clean.slice(-4)} (${clean.length} chars)`;
}
function collectMatches(code, scan) {
    const found = [];
    for (const pattern of PATTERNS) {
        if (pattern.only !== undefined && !pattern.only(scan))
            continue;
        // The only two patterns that read their value out of an assignment, and so
        // the only two where an ordinary configuration word is a plausible reading
        // of what matched. A secret-position rule shares a type with them but not
        // the doubt: nothing but a password sits after `-p` on a mysql line.
        const assignmentShaped = pattern.position !== true &&
            (pattern.type === 'password-assignment' || pattern.type === 'high-entropy-string');
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(code)) !== null) {
            // Guarantee forward progress. No pattern above can match the empty string
            // — each has a mandatory literal or a {min≥1} quantifier — but a future
            // one that could would otherwise spin here forever, hanging the caller.
            if (pattern.re.lastIndex <= m.index)
                pattern.re.lastIndex = m.index + 1;
            let start = m.index;
            let value = m[0];
            let from;
            const groups = pattern.groups ?? (pattern.group === undefined ? [] : [pattern.group]);
            if (groups.length > 0) {
                const group = groups.find((g) => m[g] !== undefined);
                if (group === undefined)
                    continue;
                from = group;
                const captured = m[group];
                // Locate the group inside the match: from the `d` flag where the rule
                // has it (a group that is not the tail of its match). Otherwise the
                // group is the trailing credential portion (at most a closing quote or
                // colon follows, which the value cannot contain), so a lastIndexOf is
                // exact.
                const at = m.indices?.[group]?.[0];
                const offset = at !== undefined ? at - m.index : m[0].lastIndexOf(captured);
                if (offset < 0)
                    continue;
                start = m.index + offset;
                value = captured;
            }
            // `${NAME:-default}`: the default is the value, and only it is replaced.
            const withDefault = WITH_DEFAULT.exec(value);
            if (withDefault !== null) {
                const fallback = withDefault[1];
                start += value.length - 1 - fallback.length;
                value = fallback;
            }
            // Structural confirmation first. A rule carrying a validator is declaring
            // its regex to be only a candidate generator — a digit run is the most
            // common shape in source code, and without the checksum this reports every
            // timestamp, version and port in the file. An unconfirmed candidate is not
            // a finding at all: it never reaches the panel, the policy, or the map.
            if (pattern.validate !== undefined && !pattern.validate(value, from))
                continue;
            let verdict = classifyValue(value, assignmentShaped);
            if (verdict === 'placeholder')
                continue;
            // Assignment-shaped findings also get an entropy check: `password: "the
            // user's password"` in prose is not a credential. Patterned filler such as
            // `password: "abababababab"` is the same judgement call as a lowercase
            // word — weak-but-real and enum-value are indistinguishable here — so it
            // lands in the same tier: surfaced, not acted on.
            if (assignmentShaped && shannonEntropy(value) < ENTROPY_FLOOR)
                verdict = 'ambiguous';
            // Decision 6: in a test, fixture or example file a weak value in a
            // secret position is a fixture. It is reported, not destroyed; a strong
            // one is destroyed there as everywhere.
            const fixture = verdict === 'credential' &&
                pattern.position === true &&
                scan.example &&
                !(pattern.keep ?? isStrong)(value);
            if (fixture)
                verdict = 'ambiguous';
            const ambiguous = verdict === 'ambiguous';
            found.push({
                type: ambiguous ? 'possible-credential' : pattern.type,
                severity: ambiguous ? 'medium' : pattern.severity,
                label: fixture
                    ? `${pattern.label} (weak, in a test or example file: reported only)`
                    : ambiguous
                        ? 'Possible hardcoded credential'
                        : pattern.label,
                start,
                end: start + value.length,
                value,
                ...(fixture ? { fixture: true } : {}),
                ...(assignmentShaped ? { generic: true } : {}),
            });
        }
        pattern.re.lastIndex = 0;
    }
    // Joined, not pushed as arguments: a manifest of 150,000 values is more
    // arguments than a call may take.
    const manifest = () => {
        if (!code.includes('Secret'))
            return [];
        // A byte-order mark is not part of the first key: the text is read
        // without it, and what is found is counted from the text as given.
        const bom = code.charCodeAt(0) === 0xfeff ? 1 : 0;
        const text = bom ? code.slice(1) : code;
        const unindented = !(scan.document || wholeJson(text));
        if (unindented && !scan.guessed)
            return [];
        const values = secretManifestValues(text, unindented);
        for (const m of values) {
            m.start += bom;
            m.end += bom;
        }
        return values;
    };
    return found.concat(keyMaterial(code), manifest(), joinedKeys(code), tokensInContext(code));
}
const QUOTED_TOKEN = /(["'`])([A-Za-z0-9+/_-]{24,200}={0,2})\1/g;
/** A credential word standing as a word of its own: `token`, `authToken`,
 *  `API_KEY`, never `author`, `tokenizer` or `keyboard`. Read after a space is
 *  put at each camel-case joint. */
const CREDENTIAL_NEARBY = /(?<![A-Za-z])(?:keys?|tokens?|secrets?|credentials?|auth|authorization|pass|passwd|passwords?|passphrase|pwd|login|bearer)(?![A-Za-z])/i;
/** How far on its line a credential word is looked for, either side. */
const NEARBY = 400;
/**
 * A quoted high-entropy token with a credential word elsewhere on its line:
 * the catch-all above asks for the word in the name directly before the
 * value; here it may stand anywhere beside it (another argument, a property
 * after it, a comment). The word must be outside the value, and outside any
 * placeholder or redaction token already in the text. Without one the value
 * is left to masking: a hash and a commit id have the same shape. Each
 * candidate reads at most its own length and 800 characters around it.
 */
function tokensInContext(code) {
    const found = [];
    QUOTED_TOKEN.lastIndex = 0;
    for (let m; (m = QUOTED_TOKEN.exec(code)) !== null;) {
        const value = m[2];
        if (!isTokenValue(value) || classifyValue(value, false) === 'placeholder')
            continue;
        const start = m.index + 1;
        const end = start + value.length;
        const before = code.slice(Math.max(0, m.index - NEARBY), m.index);
        const after = code.slice(end + 1, end + 1 + NEARBY);
        const stop = after.indexOf('\n');
        const beside = `${before.slice(before.lastIndexOf('\n') + 1)} ${stop === -1 ? after : after.slice(0, stop)}`
            .replace(/__[A-Z][A-Z0-9_]*__\d*/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        if (!CREDENTIAL_NEARBY.test(beside))
            continue;
        found.push({
            type: 'high-entropy-string',
            severity: 'medium',
            label: 'High-entropy credential',
            start,
            end,
            value,
            generic: true,
        });
    }
    QUOTED_TOKEN.lastIndex = 0;
    return found;
}
/** The provider-format rules that match a key by its own shape alone. */
let shapeRules = null;
/**
 * A provider key written as adjacent string literals (`"gh" + "p_" + "..."`,
 * or side by side, which C and Python join): the literals of a run are read
 * as the one string they become, and the part of each literal a provider rule
 * matches is redacted. Literals of one line each, without escapes; between
 * two, white space and at most one `+`. Each character is read once.
 * The language is not known here, so side-by-side literals are joined in
 * every language: reading two strings as one can only redact more.
 */
function joinedKeys(code) {
    const found = [];
    shapeRules ??= PATTERNS.filter((p) => p.disposition === 'destroy' &&
        p.position !== true &&
        !GENERIC_MATCHERS.has(p.type) &&
        p.group === undefined &&
        p.groups === undefined &&
        p.validate === undefined &&
        p.only === undefined);
    const n = code.length;
    const space = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    // The contents of the literals of the run being read.
    let run = [];
    const judge = () => {
        const literals = run;
        run = [];
        if (literals.length < 2)
            return;
        const joined = literals.map(([s, e]) => code.slice(s, e)).join('');
        for (const rule of shapeRules) {
            rule.re.lastIndex = 0;
            let m;
            while ((m = rule.re.exec(joined)) !== null) {
                if (rule.re.lastIndex <= m.index)
                    rule.re.lastIndex = m.index + 1;
                if (classifyValue(m[0], false) === 'placeholder')
                    continue;
                const from = m.index;
                const to = m.index + m[0].length;
                const pieces = [];
                let at = 0;
                for (const [s, e] of literals) {
                    const start = Math.max(from, at);
                    const end = Math.min(to, at + e - s);
                    if (start < end)
                        pieces.push({
                            type: rule.type,
                            severity: rule.severity,
                            label: `${rule.label} (joined from adjacent strings)`,
                            start: s + start - at,
                            end: s + end - at,
                            value: joined.slice(start, end),
                            piece: true,
                        });
                    at += e - s;
                }
                // Within one literal the rule itself has found it.
                if (pieces.length > 1)
                    found.push(...pieces);
            }
            rule.re.lastIndex = 0;
        }
    };
    let i = 0;
    while (i < n) {
        const quote = code[i];
        if (quote !== '"' && quote !== "'" && quote !== '`') {
            i++;
            continue;
        }
        let j = i + 1;
        while (j < n && code[j] !== quote && code[j] !== '\n' && code[j] !== '\\')
            j++;
        if (j >= n || code[j] !== quote) {
            // An escape, or no closing quote on the line: not a piece. Past the
            // literal's own end, so its closing quote opens nothing.
            judge();
            while (j < n && code[j] !== quote && code[j] !== '\n')
                j += code[j] === '\\' ? 2 : 1;
            i = j + 1;
            continue;
        }
        run.push([i + 1, j]);
        let k = j + 1;
        while (space(code[k]))
            k++;
        if (code[k] === '+')
            for (k++; space(code[k]);)
                k++;
        const next = code[k];
        if (next !== '"' && next !== "'" && next !== '`')
            judge();
        i = next === undefined ? n : k;
    }
    judge();
    return found;
}
const KEY_BEGIN = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[ \t]*$/gm;
const KEY_END = /-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;
// What `$` ends a line at: a key copied from an old Mac file or a web page
// has its lines all the same.
const ENDS_LINE = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
const BASE64_LINE = /^[A-Za-z0-9+/=]+$/;
const PEM_HEADER = /^[A-Za-z][A-Za-z0-9-]*: \S/;
/**
 * Key material the block rule above does not take: after a BEGIN line, every
 * line that is empty, a header (`Proc-Type: ...`, before the body only) or
 * made of base64 characters, up to an END line or the first other line. No
 * END line is needed (a paste cut short, a file read in part) and no length
 * is too long. A short base64-only line right after the body counts as part
 * of it: a key's tail in the map is the worse error. One walk over the lines,
 * and the next BEGIN line is looked for after it.
 */
function keyMaterial(code) {
    const found = [];
    KEY_BEGIN.lastIndex = 0;
    let m;
    while ((m = KEY_BEGIN.exec(code)) !== null) {
        // The line after the one that ends at `i`: CRLF is one line end.
        const next = (i) => i + (code[i] === '\r' && code[i + 1] === '\n' ? 2 : 1);
        let at = next(m.index + m[0].length);
        let end = -1;
        let body = false;
        // What stands before BEGIN on its line stands before every line of a key
        // shown in a diff, a quotation or a comment (`+`, `> `, `# `).
        let line0 = m.index;
        while (line0 > 0 && !ENDS_LINE(code[line0 - 1]))
            line0--;
        const prefix = code.slice(line0, m.index);
        const bare = prefix.trimEnd();
        while (at < code.length) {
            let nl = at;
            while (nl < code.length && !ENDS_LINE(code[nl]))
                nl++;
            const raw = code.slice(at, nl);
            const line = (bare === ''
                ? raw
                : raw.startsWith(prefix)
                    ? raw.slice(prefix.length)
                    : raw.startsWith(bare)
                        ? raw.slice(bare.length)
                        : raw).trim();
            if (line !== '') {
                if (BASE64_LINE.test(line))
                    body = true;
                else if (body || !PEM_HEADER.test(line)) {
                    const close = KEY_END.exec(raw);
                    if (close)
                        end = at + close.index + close[0].length;
                    break;
                }
                end = at + raw.trimEnd().length;
            }
            at = next(nl);
        }
        if (at > KEY_BEGIN.lastIndex)
            KEY_BEGIN.lastIndex = at;
        if (!body)
            continue;
        found.push({
            type: 'private-key',
            severity: 'critical',
            label: 'Private key block',
            start: m.index,
            end,
            value: code.slice(m.index, end),
        });
    }
    KEY_BEGIN.lastIndex = 0;
    return found;
}
// `kind: Secret`, in YAML or JSON, whatever the quoting - also the escaped
// quotes of a manifest held in a string. Between the colon and the word, what
// YAML allows there: a tag and an anchor (`!!str`, `&k`), a comment, and one
// line break with the value indented below. Each piece has a length limit, so
// a line of many `kind: !` is not read again from each of them.
const SECRET_AFTER_KIND = /[ \t]*:[ \t]*(?:[!&]\S{0,100}[ \t]*){0,2}(?:#[^\r\n]{0,200})?(?:\r?\n[ \t]+)?\\?["']?Secret(?![\w$-])/
    .source;
const NAMES_SECRET = new RegExp(`(?<![\\w$.-])\\\\?["']?kind\\\\?["']?${SECRET_AFTER_KIND}`);
// The same, as text of no stated kind must have it: the key unquoted and
// first on its line, and nothing after the word but white space or a comment
// (`kind: Secret,` is an argument in code).
const NAMES_SECRET_UNINDENTED = new RegExp(`^kind${SECRET_AFTER_KIND}\\\\?["']?[ \\t]*(?:#.*)?\\r?$`, 'm');
const DATA_KEY = /(?<![\w$.-])\\?["']?(?:data|stringData)\\?["']?[ \t]*:[ \t]*/g;
const BLOCK_SCALAR = /^[|>][-+0-9]*$/;
/** Text that is one JSON value as a whole: a document whatever its path, since
 *  no code parses as JSON. */
function wholeJson(code) {
    if (!/^\s*[{[]/.test(code))
        return false;
    try {
        JSON.parse(code);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Every value under `data` and `stringData` of a Kubernetes manifest of
 * `kind: Secret`: a credential whatever its key is called. One rule, toward
 * redacting: in a document (the text between `---` lines) that names the kind
 * anywhere, in any quoting, each `data` and `stringData` key (first on its
 * line, or after `{` or `,`) opens a region -
 * a `{ ... }` to its closing brace, or the lines indented deeper than the key
 * - and every scalar value in it is redacted, block scalars whole. So a List
 * that holds a Secret has the values of its other items redacted too. A value
 * whose quote never closes runs to the closing brace or the end of its line.
 * Only in a YAML or JSON document (`ScanContext.document`, or text that is
 * JSON as a whole): an object in code that names the kind holds names, which
 * are masked and restored. Text with no path, kind or language (`unindented`)
 * is read more narrowly, since it may be code: a document must name the kind
 * with an unquoted `kind:` first on a line that ends after the word (white
 * space and a comment aside), and only an unquoted `data` or `stringData`
 * first on a line opens a region, unless a value on that line ends in a comma. A Secret a template builds
 * (Helm) is not recognised. One pass over each document.
 */
function secretManifestValues(code, unindented) {
    const found = [];
    const emit = (start, end) => {
        const value = code.slice(start, end);
        if (start >= end || classifyValue(value, false) === 'placeholder')
            return;
        found.push({
            type: 'password-assignment',
            severity: 'high',
            label: 'Value of a Kubernetes Secret',
            start,
            end,
            value,
            whole: true,
            // A short value (`true`, a port) is ordinary text anywhere else.
            ...(value.length < 8 ? { piece: true } : {}),
        });
    };
    const blank = (c) => c === ' ' || c === '\t' || c === '\r';
    // The line end last found, kept: a line of many values asks for it once.
    let lineFrom = -1;
    let lineTo = -1;
    const lineEnd = (at, limit) => {
        if (at < lineFrom || at > lineTo) {
            const nl = code.indexOf('\n', at);
            lineFrom = at;
            lineTo = nl === -1 ? code.length : nl;
        }
        return Math.min(lineTo, limit);
    };
    /** The quoted text that opens at `at` (`"`, `'` or an escaped `\"`): where
     *  its contents start and end, and where reading goes on. `''` is the quote
     *  inside single quotes, a backslash escapes inside double ones. Never closed on
     *  its line, it runs to the line's end - `inBraces`, to the line's last
     *  closing brace if it has one; what the next line carries on with is read
     *  there as a value. */
    const quoted = (at, limit, inBraces = false) => {
        const escaped = code[at] === '\\';
        const quote = code[escaped ? at + 1 : at];
        const start = at + (escaped ? 2 : 1);
        const stop = lineEnd(start, limit);
        let brace = -1;
        for (let j = start; j < stop; j++) {
            if (escaped) {
                if (code[j] === '\\' && code[j + 1] === quote)
                    return { start, end: j, next: j + 2, closed: true };
            }
            else if (code[j] === quote) {
                if (quote === "'" && code[j + 1] === "'")
                    j++;
                else
                    return { start, end: j, next: j + 1, closed: true };
            }
            else if (code[j] === '\\' && quote === '"')
                j++;
            if (inBraces && code[j] === '}')
                brace = j;
        }
        const end = brace === -1 ? stop : brace;
        return { start, end, next: end, closed: false };
    };
    const opensQuote = (at) => code[at] === '"' || code[at] === "'" || (code[at] === '\\' && code[at + 1] === '"');
    /** Whether the `:` at `at` ends a key: white space, a line end, a quote or
     *  an opening bracket follows (`http://host` holds a colon that does not). */
    const endsKey = (at, limit) => at + 1 >= limit ||
        blank(code[at + 1]) ||
        code[at + 1] === '\n' ||
        code[at + 1] === '{' ||
        code[at + 1] === '[' ||
        opensQuote(at + 1);
    /** The mapping in braces that opens at `open`, over as many lines as it
     *  has: every scalar in it that is not a key - quoted or plain, after a
     *  colon, in a sequence, or carried on from the line before. Answers where
     *  it closes, or `limit`. */
    const flow = (open, limit) => {
        let depth = 0;
        for (let i = open; i < limit; i++) {
            const c = code[i];
            if (c === '{' || c === '[')
                depth++;
            else if (c === '}' || c === ']') {
                if (--depth <= 0)
                    return i + 1;
            }
            else if (c === ',' || c === ':' || c === '\n' || blank(c))
                continue;
            else if (opensQuote(i)) {
                const q = quoted(i, limit, true);
                let after = q.next;
                while (blank(code[after]))
                    after++;
                // A key is closed and has its colon; anything else quoted is a value.
                if (!q.closed || code[after] !== ':')
                    emit(q.start, q.end);
                i = q.next - 1;
            }
            else {
                let j = i;
                let key = false;
                for (; j < limit && !',}]\n'.includes(code[j]); j++)
                    if (code[j] === ':' && endsKey(j, limit)) {
                        key = true;
                        break;
                    }
                if (!key) {
                    let end = j;
                    while (end > i && blank(code[end - 1]))
                        end--;
                    emit(i, end);
                }
                i = key ? j : j - 1;
            }
        }
        return limit;
    };
    /** The lines indented deeper than `column` from `at` on: the value of each,
     *  or the line itself when it holds no key; a block scalar as one value.
     *  Answers where the region ends. */
    const block = (at, limit, column) => {
        let scalar = -1;
        let body = null;
        const close = () => {
            if (body)
                emit(body[0], body[1]);
            body = null;
            scalar = -1;
        };
        while (at < limit) {
            const stop = lineEnd(at, limit);
            let to = stop;
            while (to > at && blank(code[to - 1]))
                to--;
            let first = at;
            // A tab indents too: not YAML, and so not a reason to skip the block.
            while (first < to && (code[first] === ' ' || code[first] === '\t'))
                first++;
            if (first < to) {
                const indent = first - at;
                if (indent <= column)
                    break;
                if (scalar !== -1 && indent > scalar) {
                    if (body === null)
                        body = [first, to];
                    else
                        body[1] = to;
                }
                else if (code[first] !== '#') {
                    close();
                    // After a list dash, and after the first `: ` if there is one.
                    let start = code[first] === '-' && (first + 1 === to || blank(code[first + 1])) ? first + 1 : first;
                    for (let i = start; i < to; i++)
                        if (code[i] === ':' && (i + 1 === to || blank(code[i + 1]))) {
                            start = i + 1;
                            break;
                        }
                    while (start < to && blank(code[start]))
                        start++;
                    if (BLOCK_SCALAR.test(code.slice(start, to)))
                        scalar = indent;
                    else if (code[start] === '{')
                        flow(start, to);
                    else if (opensQuote(start)) {
                        const q = quoted(start, to);
                        // What follows the closing quote (a comma) is not the value.
                        emit(q.start, q.end);
                    }
                    else if (!/^[{}[\],]+$/.test(code.slice(start, to)))
                        emit(start, to);
                }
            }
            at = stop + 1;
        }
        close();
        return Math.min(at, limit);
    };
    // The document being read: where it starts and ends, and whether it names
    // the kind. Found once per document, as the keys are met.
    let from = 0;
    let limit = -1;
    let secret = false;
    DATA_KEY.lastIndex = 0;
    for (let m; (m = DATA_KEY.exec(code)) !== null;) {
        while (limit === -1 || m.index >= limit) {
            if (limit !== -1)
                from = limit + 3;
            const separator = code.indexOf('\n---', from);
            limit = separator === -1 ? code.length : separator + 1;
            secret =
                m.index < limit &&
                    (unindented ? NAMES_SECRET_UNINDENTED : NAMES_SECRET).test(code.slice(from, limit));
        }
        if (!secret)
            continue;
        if (unindented && !(/^[ds]/.test(m[0]) && (m.index === 0 || /[\n\r]/.test(code[m.index - 1]))))
            continue;
        // A key stands first on its line (after a list dash), or after `{` or
        // `,`: `if data:` and `(data: Buffer)` in code open nothing.
        let before = m.index - 1;
        while (before >= 0 && blank(code[before]))
            before--;
        if (code[before] === '-')
            for (before--; before >= 0 && blank(code[before]);)
                before--;
        if (before >= 0 && !'\n{,'.includes(code[before]))
            continue;
        // After a comma, only inside braces: `(data: Buffer, stringData: string)`
        // is a list of parameters. Looked for on the line, 200 characters back at
        // most; not found, it is read as a key.
        if (code[before] === ',') {
            let depth = 0;
            let opener = '';
            for (let i = before - 1; i >= 0 && i > before - 200 && code[i] !== '\n'; i--) {
                const c = code[i];
                if (c === ')' || c === ']' || c === '}')
                    depth++;
                else if (c === '(' || c === '[' || c === '{') {
                    if (depth === 0) {
                        opener = c;
                        break;
                    }
                    depth--;
                }
            }
            if (opener === '(' || opener === '[')
                continue;
        }
        const at = DATA_KEY.lastIndex;
        const stop = lineEnd(at, limit);
        let to = stop;
        while (to > at && blank(code[to - 1]))
            to--;
        // In text of no stated kind, a value on the key's line that ends in a
        // comma is an argument in code, not a manifest's key.
        if (unindented && to > at && code[at] !== '#' && code[to - 1] === ',')
            continue;
        // Asked for at most once a line: the reading goes on at the next line.
        const column = () => m.index - (code.lastIndexOf('\n', m.index) + 1);
        let next;
        if (code[at] === '{')
            next = flow(at, limit);
        else if (at >= stop || code[at] === '#' || code[at] === '\r')
            next = block(stop + 1, limit, column());
        else {
            if (opensQuote(at)) {
                const q = quoted(at, to);
                emit(q.start, q.end);
            }
            else
                emit(at, to);
            // What stands after the key may be an anchor or a tag, with the
            // mapping on the lines below.
            next = block(stop + 1, limit, column());
        }
        DATA_KEY.lastIndex = Math.max(next, at);
    }
    DATA_KEY.lastIndex = 0;
    return found;
}
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
/**
 * How specifically a rule identified what it matched.
 *
 * Overlap resolution is about SPECIFICITY, not alarm. It used to rank by
 * severity, which worked only while the two happened to coincide — the moment
 * `connection-string` was graded critical to reflect what a leaked database URL
 * actually costs, the container started swallowing the GitHub token inside it
 * and the report got less useful for being more alarmed.
 *
 * A named provider format beats a generic container, which beats a low-value
 * match, which beats the catch-all. Nothing here reads `severity`.
 */
const GENERIC_MATCHERS = new Set([
    'connection-string',
    'basic-auth',
    'bearer-token',
    'jwt',
    'password-assignment',
    'high-entropy-string',
]);
function detectionPriority(type) {
    if (type === 'possible-credential')
        return 0;
    if (type === 'email' || type === 'private-ip')
        return 1;
    if (GENERIC_MATCHERS.has(type))
        return 2;
    return 3;
}
/** A downgraded fixture ranks as the generic credential rule it came from. */
function priorityOf(m) {
    return m.fixture === true ? detectionPriority('password-assignment') : detectionPriority(m.type);
}
/** How much is at stake if this match LOSES an overlap: a destroyed value
 *  outranks a masked one, which outranks one that is only reported. */
function dispositionRank(type) {
    const d = SECRET_DISPOSITIONS[type];
    return d === 'destroy' ? 2 : d === 'mask' ? 1 : 0;
}
/** Drop matches contained in, or overlapping, a more specific match. A Stripe
 *  key inside a connection string should be reported once, as the Stripe key.
 *
 *  DISPOSITION FIRST, then specificity. The IBAN / card / PESEL detectors are
 *  more specific than the generic credential matchers, and used to win on that
 *  alone - harmless while they were destroyed too. Once they became reversible
 *  (spec 009), `password = "<a Luhn-valid number>"` lost its password match to
 *  the card match and the password was written into the SymbolMap, and stopped
 *  blocking the paste. A value any rule reads as a credential is never masked:
 *  within the same disposition the old specificity order still decides. */
function dropOverlaps(all, code) {
    // The context verdict first: a generic assignment match over a downgraded
    // fixture is the same value read without its context, and must not turn a
    // report back into a redaction. Only one that lies within the fixture: one
    // that runs past it holds more than the fixture, and the normal order
    // decides (second security review). A provider-format match still wins.
    const fixtures = all.filter((m) => m.fixture === true);
    const matches = fixtures.length === 0
        ? all
        : all.filter((m) => m.generic !== true || !fixtures.some((f) => f.start <= m.start && m.end <= f.end));
    const sorted = [...matches].sort((a, b) => {
        const byDisposition = dispositionRank(b.type) - dispositionRank(a.type);
        if (byDisposition !== 0)
            return byDisposition;
        const byWhole = Number(b.whole === true) - Number(a.whole === true);
        if (byWhole !== 0)
            return byWhole;
        const byPriority = priorityOf(b) - priorityOf(a);
        if (byPriority !== 0)
            return byPriority;
        const byLength = b.end - b.start - (a.end - a.start);
        if (byLength !== 0)
            return byLength;
        return a.start - b.start;
    });
    const kept = [];
    // Which kept matches reach into each stretch of 64 characters, by their
    // place in `kept`: an overlap is looked for there, not in all of `kept`.
    const near = new Map();
    const note = (at) => {
        const k = kept[at];
        for (let b = k.start >> 6; b <= (k.end - 1) >> 6; b++) {
            const list = near.get(b);
            if (list)
                list.push(at);
            else
                near.set(b, [at]);
        }
    };
    /** The first kept match, in rank order, that overlaps `m`. */
    const winnerOf = (m) => {
        let first = -1;
        for (let b = m.start >> 6; b <= (m.end - 1) >> 6; b++)
            for (const at of near.get(b) ?? []) {
                const k = kept[at];
                if ((first === -1 || at < first) && m.start < k.end && k.start < m.end)
                    first = at;
            }
        return first;
    };
    let grown = false;
    for (const m of sorted) {
        const at = winnerOf(m);
        if (at === -1) {
            kept.push(m);
            note(kept.length - 1);
            continue;
        }
        const winner = kept[at];
        // An AMBIGUOUS credential verdict ("might be a live secret, might be a
        // word") loses to a mask match on rank - it is only reported. Letting the
        // mask stand would write a possible live credential into the map, and
        // letting the report stand would send it to the model verbatim. The value
        // is destroyed instead: the one outcome that does neither.
        if (m.type === 'possible-credential' && SECRET_DISPOSITIONS[winner.type] === 'mask') {
            winner.forceDestroy = true;
        }
        // A whole value wins over what it contains. A credential that runs past
        // it (a key block that starts in it) is not dropped with its tail left
        // readable: the two are redacted as one span.
        if (winner.whole === true && dispositionRank(m.type) === 2) {
            if (m.start < winner.start || m.end > winner.end)
                grown = true;
            winner.start = Math.min(winner.start, m.start);
            winner.end = Math.max(winner.end, m.end);
            note(at);
        }
    }
    kept.sort((a, b) => a.start - b.start);
    if (!grown)
        return kept;
    // A span that grew may now reach its neighbours: those join it.
    const joined = [];
    for (const m of kept) {
        const last = joined[joined.length - 1];
        if (last !== undefined && m.start < last.end)
            last.end = Math.max(last.end, m.end);
        else
            joined.push(m);
    }
    for (const m of joined)
        if (m.whole === true)
            m.value = code.slice(m.start, m.end);
    return joined;
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
export function destroysValue(type) {
    return SECRET_DISPOSITIONS[type] === 'destroy';
}
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
export function blocksPaste(type) {
    return SECRET_DISPOSITIONS[type] === 'destroy';
}
// The deny-list that used to live here (REPORT_ONLY_TYPES, isActionable) is
// gone. Its virtue was that an UNLISTED rule redacted by default — safety by
// omission: a contributor got the right outcome by not acting.
//
// The required `disposition` field replaces it with safety by construction: a
// contributor cannot not-act, because an unclassified rule does not compile.
// That is strictly stronger, so nothing was traded away. The three types the
// old list named are now `report` on the rule itself, with the reasoning at
// each assignment:
//   - `email`, `private-ip`  common, low-risk, and blanking one corrupts code
//                            for no safety gain.
//   - `possible-credential`  the ambiguous verdict — see SECRET_DISPOSITIONS.
//
// Nothing was left behind as a shim. A retained `isActionable` would be exactly
// the second source of truth this design exists to remove.
const TYPE_TOKENS = {
    'aws-access-key': 'AWS_KEY',
    'aws-secret-key': 'AWS_SECRET',
    'private-key': 'PRIVATE_KEY',
    'stripe-key': 'STRIPE_KEY',
    'github-token': 'GITHUB_TOKEN',
    'gitlab-token': 'GITLAB_TOKEN',
    'slack-token': 'SLACK_TOKEN',
    'slack-webhook': 'SLACK_WEBHOOK',
    'discord-token': 'DISCORD_TOKEN',
    'openai-key': 'OPENAI_KEY',
    'anthropic-key': 'ANTHROPIC_KEY',
    'google-api-key': 'GOOGLE_KEY',
    'gcp-service-account': 'GCP_SERVICE_ACCOUNT',
    'azure-key': 'AZURE_KEY',
    'npm-token': 'NPM_TOKEN',
    'pypi-token': 'PYPI_TOKEN',
    'sendgrid-key': 'SENDGRID_KEY',
    'twilio-key': 'TWILIO_SID',
    'mailgun-key': 'MAILGUN_KEY',
    'datadog-key': 'DATADOG_KEY',
    'hugging-face-token': 'HF_TOKEN',
    'supabase-key': 'SUPABASE_KEY',
    'square-token': 'SQUARE_TOKEN',
    'shopify-token': 'SHOPIFY_TOKEN',
    'cloudflare-token': 'CLOUDFLARE_TOKEN',
    'digitalocean-token': 'DIGITALOCEAN_TOKEN',
    'sentry-token': 'SENTRY_TOKEN',
    'linear-key': 'LINEAR_KEY',
    'vault-token': 'VAULT_TOKEN',
    'age-secret-key': 'AGE_KEY',
    'heroku-token': 'HEROKU_TOKEN',
    jwt: 'JWT',
    'bearer-token': 'BEARER_TOKEN',
    'basic-auth': 'BASIC_AUTH',
    'connection-string': 'DB_PASSWORD',
    'password-assignment': 'CREDENTIAL',
    // Unreachable while `medium` stays out of REDACTED_SEVERITIES, but present so
    // that widening the policy cannot produce an undefined token.
    'possible-credential': 'CREDENTIAL',
    'high-entropy-string': 'SECRET',
    email: 'EMAIL',
    'private-ip': 'PRIVATE_IP',
    iban: 'IBAN',
    'payment-card': 'CARD_NUMBER',
    pesel: 'PESEL',
};
/** The redaction tokens scanSecrets writes (`__REDACTED_CREDENTIAL_1__`), and
 *  the one the guard writes for a masked-kind number it cannot mask
 *  (`__REDACTED_IBAN__`, from the type's name: veilio-guard lib/scrub.ts),
 *  whole and of a known kind. */
export const REDACTION_TOKENS = new RegExp(`__REDACTED_(?:${[...new Set(Object.values(TYPE_TOKENS))].join('|')})_\\d+__|__REDACTED_(?:${Object.keys(SECRET_DISPOSITIONS)
    .filter((type) => SECRET_DISPOSITIONS[type] === 'mask')
    .map((type) => type.toUpperCase().replace(/[^A-Z0-9]/g, '_'))
    .join('|')})__`, 'g');
/**
 * The file kind of `path`, as the engine reads it, or undefined for any other
 * file (spec 013 R19). Clients pass the result as `fileKind` instead of the
 * path: a kind only adds rules, it never relaxes one, so the test-file
 * relaxation that a `path` brings stays off.
 * - dotenv: `.env`, `.env.<word>` (`.env.local`, `.env.production`) and
 *   `*.env`, in any case - not `.env.ts`, `.env.d.ts` or `.env.example.json`,
 *   which are code or data;
 * - YAML: `.yml`, `.yaml`;
 * - shell: `.sh`, `.bash`, `.zsh`, `.ksh`, a Dockerfile, and shell rc files;
 * - ini: `.ini`, `.cfg`, `.conf`, `.properties`, `.toml`;
 * - xml: `.xml`, `.config`, `.xaml`, `.csproj`, `.props`, `.targets`, `.plist`;
 * - pgpass: `.pgpass`, whose fifth field is a password;
 * - text: a document (`.md`, `.mdx`, `.rst`) and any file of none of these
 *   kinds and no code extension (`.txt`, `.tfvars`, `.bat`, `Makefile`,
 *   `.netrc`): every value grammar applies (security review, round 4).
 * The last four add no secret rules: they tell masking where values stand.
 */
const CODE_EXTENSIONS = /^(?:[cm]?[jt]sx?|json|jsonc|toml|py|pyi|rb|go|java|kt|kts|scala|rs|swift|dart|exs?|lua|php|cs|fs|c|cc|cpp|h|hpp|m|mm|vue|svelte|md|mdx|rst|html|xml|sql|r|pl|ps1)$/i;
export function fileKindOf(path) {
    const name = path.split(/[\\/]/).pop() ?? '';
    const last = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    // Never a code, data or document file, whatever its name starts with
    // (`dockerfile.py`, `Dockerfile.test.ts`, `.env.rs`, `.env.md`).
    if (last && CODE_EXTENSIONS.test(last))
        return /^toml$/i.test(last)
            ? 'ini'
            : /^xml$/i.test(last)
                ? 'xml'
                : /^(?:md|mdx|rst)$/i.test(last)
                    ? 'text'
                    : undefined;
    if (/\.ya?ml$/i.test(name))
        return 'yaml';
    if (/\.(?:sh|bash|zsh|ksh)$/i.test(name) ||
        /^Dockerfile(?:\..*)?$|\.dockerfile$/i.test(name) ||
        /^\.(?:envrc|bashrc|zshrc|profile|bash_profile|zprofile)$/i.test(name))
        return 'shell';
    // `.env`, `*.env`, and `.env.<anything>` - `.env.local`, `.env.txt`, a `~` backup.
    if (/\.env$/i.test(name) || /^\.env\./i.test(name))
        return 'dotenv';
    if (/^(?:ini|cfg|conf|properties)$/i.test(last))
        return 'ini';
    if (/^(?:config|xaml|csproj|props|targets|plist)$/i.test(last))
        return 'xml';
    if (/^\.?pgpass$/i.test(name))
        return 'pgpass';
    return 'text';
}
const SCAN_OPTIONS = optionKeys({
    path: true,
    root: true,
    fileKind: true,
    language: true,
});
const FILE_KINDS = new Set([
    'dotenv',
    'yaml',
    'shell',
    'ini',
    'xml',
    'pgpass',
    'text',
]);
function scanContext(options) {
    const path = options.path;
    if (options.fileKind !== undefined && !FILE_KINDS.has(options.fileKind))
        throw new TypeError(`unknown fileKind '${String(options.fileKind)}'. Valid: ${[...FILE_KINDS].join(', ')}.`);
    // An explicit kind adds to the one the path implies; it never replaces it,
    // so no kind can turn a rule off.
    const kinds = new Set([options.fileKind, path === undefined ? undefined : fileKindOf(path)]);
    return {
        example: path !== undefined && isExamplePath(path, options.root),
        dotenv: kinds.has('dotenv'),
        yaml: kinds.has('yaml'),
        document: kinds.has('yaml') || (path !== undefined && /\.json$/i.test(path)),
        guessed: path === undefined &&
            options.fileKind === undefined &&
            (options.language ?? 'auto') === 'auto',
        shell: kinds.has('shell'),
    };
}
/**
 * Where the credentials in `code` stand, whatever the policy: every value a
 * rule would destroy, and every value it only reports as a possible
 * credential. The masking pass leaves these alone, so a credential never
 * reaches the symbol map in any `secrets` mode (founder decision 2026-10-26).
 */
export function credentialSpans(code, options = {}) {
    assertKnownOptions('credentialSpans', options, SCAN_OPTIONS);
    return dropOverlaps(collectMatches(code, scanContext(options)), code)
        .filter((m) => m.type === 'possible-credential' || SECRET_DISPOSITIONS[m.type] === 'destroy')
        .map((m) => ({
        start: m.start,
        end: m.end,
        ambiguous: m.type === 'possible-credential' && m.fixture !== true,
    }));
}
/** Detect credentials in `code` without modifying it. */
export function detectSecrets(code, options = {}) {
    assertKnownOptions('detectSecrets', options, SCAN_OPTIONS);
    return scan(code, 'warn', options).findings;
}
/**
 * Detect credentials and, under the `redact` policy, replace critical/high
 * findings with `__REDACTED_<TYPE>_<n>__` tokens.
 *
 * The replacement is placeholder-shaped, so the engine's existing
 * PLACEHOLDER_TOKEN guard keeps it out of identifier extraction. Because it is
 * never written to the SymbolMap, `restore()` leaves it in place — the redaction
 * is one-way by construction, not by convention.
 */
export function scanSecrets(code, policy = 'redact', options = {}) {
    assertKnownOptions('scanSecrets', options, SCAN_OPTIONS);
    const language = options.language ?? 'auto';
    if (language !== 'auto' && !LANGUAGES.includes(language))
        throw new TypeError(`unknown language '${String(language)}'. Valid: auto, ${LANGUAGES.join(', ')}.`);
    return scan(code, policy, options);
}
/** `scanSecrets` with its options already checked. */
function scan(code, policy, options) {
    if (policy === 'off')
        return { findings: [], code, regulated: [] };
    const matches = dropOverlaps(collectMatches(code, scanContext(options)), code);
    if (matches.length === 0)
        return { findings: [], code, regulated: [] };
    const starts = lineIndex(code);
    const findings = [];
    const counters = {};
    // In source order, as `dropOverlaps` hands the matches over, none over another.
    const replacements = [];
    const regulated = [];
    const tokens = new Map();
    for (const m of matches) {
        const active = policy === 'redact';
        const willRedact = active && (m.forceDestroy === true || destroysValue(m.type));
        // Under `warn` the disposition is what the rule says, but nothing is acted
        // on — so the finding reports `report`, which is what actually happened to
        // the value. Reporting `mask` for a value still sitting untouched in the
        // code would be the same kind of lie `redacted` used to risk telling.
        const disposition = !active
            ? 'report'
            : m.forceDestroy === true
                ? 'destroy'
                : SECRET_DISPOSITIONS[m.type];
        const { line, column } = positionOf(starts, m.start);
        findings.push({
            type: m.type,
            severity: m.severity,
            label: m.label,
            line,
            column,
            length: m.value.length,
            preview: previewSecret(m.value),
            redacted: willRedact,
            disposition,
        });
        if (disposition === 'mask') {
            // Handed over, not replaced. The masking pass owns the map.
            regulated.push({ type: m.type, value: m.value });
        }
        if (willRedact) {
            const base = TYPE_TOKENS[m.type];
            const n = (counters[base] ?? 0) + 1;
            counters[base] = n;
            const token = `__REDACTED_${base}_${n}__`;
            replacements.push({ start: m.start, end: m.end, token });
            if (m.piece !== true && !tokens.has(m.value))
                tokens.set(m.value, token);
        }
    }
    // In source order, each piece of the text copied once.
    const pieces = [];
    let copied = 0;
    for (const r of replacements) {
        pieces.push(code.slice(copied, r.start), r.token);
        copied = r.end;
    }
    const redacted = pieces.join('') + code.slice(copied);
    // FR-001: ordered by what the reader should act on first, not by the order
    // the rule table happens to be written in. `replacements` is deliberately not
    // reordered — it is applied by offset and must stay in source order.
    findings.sort((a, b) => {
        const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (bySeverity !== 0)
            return bySeverity;
        if (a.line !== b.line)
            return a.line - b.line;
        return a.column - b.column;
    });
    const result = { findings, code: redacted, regulated };
    tokensByScan.set(result, tokens);
    return result;
}
/** Each destroyed value of a scan, with the token that replaced it. Held
 *  beside the scan rather than on it, so a scan result never carries a
 *  secret: only a caller that already has the text can ask for a value. */
const tokensByScan = new WeakMap();
/**
 * Every value a scan destroyed, with the token that replaced it. `anonymize`
 * writes the same token over every other occurrence of the value (1.12.1
 * security review), so a password used again is never shown to the model nor
 * written to the map. Empty for a scan that destroyed nothing.
 */
export function redactionTokensOf(scan) {
    return tokensByScan.get(scan) ?? new Map();
}
/** True when the scan found anything that should stop a user from pasting. */
export function hasBlockingSecrets(findings) {
    // By type, never by display grade: re-grading a token to calm the panel must
    // not silently unblock a live credential.
    //
    // `blocksPaste`, not `destroysValue` — they agree today and are allowed not
    // to. A regulated identifier is masked but does NOT block: blocking exists to
    // stop a live credential reaching a model, and refusing the billing code this
    // tool was built for is not that.
    return findings.some((f) => blocksPaste(f.type));
}
/** Count findings by severity, for badges and audit records. */
export function summarizeSecrets(findings) {
    const summary = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings)
        summary[f.severity]++;
    return summary;
}
