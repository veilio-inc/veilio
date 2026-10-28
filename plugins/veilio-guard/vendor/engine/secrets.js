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
/** A bare shell value of any length (spec 013 R17): the 1.12.1 grammar
 *  without its 256-character cap, so a long value never keeps a plain tail.
 *  Linear: the unit's alternatives start on different characters. */
const BARE_LONG = `((?:${BARE_UNIT})+)`;
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
const notBlockIndicator = (value) => !/^[|>][-+0-9]*$/.test(value);
/** In a YAML file, YAML syntax is never a value: a block indicator, an alias,
 *  or a bare tag or anchor. A tag or anchor before a value is stepped over by
 *  the rule (YAML_PROPS) and the value after it judged. */
const notYamlSyntax = (value) => notBlockIndicator(value) && !/^(?:\*\S+|&\S+|!\S*)$/.test(value);
const YAML_PROPS = '(?:(?:&[^\\s]+|![^\\s]*)[ \\t]+)*';
/** A unified-diff line's first character (`+`, `-`, a space), so a patch reads
 *  as the lines it holds: `+DB_PASSWORD=…` is an assignment too. Only adds. */
const DIFF = '[+\\- ]?';
/** Quoted values in the new rules have no length cap, so a long quoted value
 *  is never left whole in the map (security review of 11f2d20). YAML quotes
 *  by its own rules: `''` inside single quotes, a backslash escape inside
 *  double quotes. A quote that does not close on its line takes the rest of
 *  the line. All linear. */
const ENV_DQ = '"([^"\\n]*)"';
const ENV_SQ = "'([^'\\n]*)'";
const YAML_DQ = '"((?:[^"\\\\\\n]|\\\\.)*)"';
const YAML_SQ = "'((?:[^'\\n]|'')*)'";
const UNCLOSED = '(["\'][^\\n]*)';
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
        // dotenv: NAME=v, NAME = v, optional export - the rest of the line.
        // Convention names in any case there (dotenv keys are not always upper case).
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*(?:export[ \\t]+)?["']?(?:${names})["']?[ \\t]*=[ \\t]*(?:${PH}|${ENV_DQ}|${ENV_SQ}|${LINE_VALUE}|${UNCLOSED})`, fixed ? 'gm' : 'gmi'),
            groups: [1, 2, 3, 4],
            only: (scan) => scan.dotenv,
        });
        // YAML: NAME: v - the rest of the line, never YAML syntax.
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*["']?(?:${names})["']?[ \\t]*:[ \\t]*${YAML_PROPS}(?:${PH}|${YAML_DQ}|${YAML_SQ}|${LINE_VALUE}|${UNCLOSED})`, 'gm'),
            groups: [1, 2, 3, 4],
            only: (scan) => scan.yaml,
            validate: (value, group) => group !== 3 || notYamlSyntax(value),
        });
        // YAML compose list: - NAME=v, - "NAME=v", - 'NAME=v' (the quote kept).
        rules.push({
            ...base,
            re: new RegExp(`^${DIFF}[ \\t]*-[ \\t]+(?:"(?:${names})=([^"\\n]+)"|'(?:${names})=([^'\\n]+)'|(?:${names})=(?:${PH}|${LINE_VALUE})|["'](?:${names})=([^\\n]+))`, 'gm'),
            groups: [1, 2, 3, 4],
            only: (scan) => scan.yaml,
        });
        // shell and Dockerfile: NAME=v after export, ENV and the like, in shell
        // grammar. Fixed names are R2's anywhere on a line already.
        if (!fixed)
            rules.push({
                ...base,
                re: new RegExp(`^${DIFF}[ \\t]*(?:(?:export|declare[ \\t]+-x|readonly|local|ENV|ARG)[ \\t]+)?(?:${names})=(?:${PH}|${DQ}(?=[\\s;&|]|$)|${SQ}(?=[\\s;&|]|$)|${SHELL_WORD})`, 'gm'),
                groups: [1, 2, 3],
                only: (scan) => scan.shell,
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
        re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
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
        re: new RegExp(`(?<![\\w])(?:${PASSWORD_ENV})(?:["']?[ \\t]{0,3}=[ \\t]{0,3}(?:${PH}|${DQ}|${SQ})|=(?:${PH}|${BARE_LONG})|["']?[ \\t]{0,3}:[ \\t]{0,3}(?:${PH}|${DQ}|${SQ}|${BARE_LONG}))`, 'g'),
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
    if (clean.length <= 12)
        return `${clean.slice(0, 2)}${'•'.repeat(Math.max(clean.length - 2, 1))}`;
    return `${clean.slice(0, 4)}…${clean.slice(-4)} (${clean.length} chars)`;
}
/** Byte offset → 1-based line/column, computed once per scan. */
function lineIndex(code) {
    const starts = [0];
    for (let i = 0; i < code.length; i++) {
        if (code[i] === '\n')
            starts.push(i + 1);
    }
    return starts;
}
function positionOf(starts, offset) {
    // Binary search for the last line start at or before `offset`.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (starts[mid] <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
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
function dropOverlaps(all) {
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
        const byPriority = priorityOf(b) - priorityOf(a);
        if (byPriority !== 0)
            return byPriority;
        const byLength = b.end - b.start - (a.end - a.start);
        if (byLength !== 0)
            return byLength;
        return a.start - b.start;
    });
    const kept = [];
    for (const m of sorted) {
        const winner = kept.find((k) => m.start < k.end && k.start < m.end);
        if (!winner) {
            kept.push(m);
            continue;
        }
        // An AMBIGUOUS credential verdict ("might be a live secret, might be a
        // word") loses to a mask match on rank - it is only reported. Letting the
        // mask stand would write a possible live credential into the map, and
        // letting the report stand would send it to the model verbatim. The value
        // is destroyed instead: the one outcome that does neither.
        if (m.type === 'possible-credential' && SECRET_DISPOSITIONS[winner.type] === 'mask') {
            winner.forceDestroy = true;
        }
    }
    return kept.sort((a, b) => a.start - b.start);
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
 * - shell: `.sh`, `.bash`, `.zsh`, `.ksh`, a Dockerfile, and shell rc files.
 */
export function fileKindOf(path) {
    const name = path.split(/[\\/]/).pop() ?? '';
    if (/\.ya?ml$/i.test(name))
        return 'yaml';
    if (/\.(?:sh|bash|zsh|ksh)$/i.test(name) ||
        /^Dockerfile(?:\..*)?$|\.dockerfile$/i.test(name) ||
        /^\.(?:envrc|bashrc|zshrc|profile|bash_profile|zprofile)$/i.test(name))
        return 'shell';
    if (/\.env$/i.test(name))
        return 'dotenv';
    // `.env.<anything>` is dotenv - `.env.local`, `.env.txt`, a `~` backup -
    // unless its last extension is code or structured data (`.env.ts`,
    // `.env.d.ts`, `.env.example.json`).
    if (/^\.env\./i.test(name)) {
        const last = name.slice(name.lastIndexOf('.') + 1);
        return /^(?:[cm]?[jt]sx?|json|toml|py|rb|go|java|kt|cs|php)$/i.test(last) ? undefined : 'dotenv';
    }
    return undefined;
}
const SCAN_OPTIONS = optionKeys({ path: true, root: true, fileKind: true });
const FILE_KINDS = new Set(['dotenv', 'yaml', 'shell']);
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
    return dropOverlaps(collectMatches(code, scanContext(options)))
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
    return scan(code, policy, options);
}
/** `scanSecrets` with its options already checked. */
function scan(code, policy, options) {
    if (policy === 'off')
        return { findings: [], code, regulated: [] };
    const matches = dropOverlaps(collectMatches(code, scanContext(options)));
    if (matches.length === 0)
        return { findings: [], code, regulated: [] };
    const starts = lineIndex(code);
    const findings = [];
    const counters = {};
    // Replace back-to-front so earlier offsets stay valid.
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
            if (!tokens.has(m.value))
                tokens.set(m.value, token);
        }
    }
    let redacted = code;
    for (let i = replacements.length - 1; i >= 0; i--) {
        const r = replacements[i];
        redacted = redacted.slice(0, r.start) + r.token + redacted.slice(r.end);
    }
    // FR-001: ordered by what the reader should act on first, not by the order
    // the rule table happens to be written in. `replacements` is deliberately not
    // reordered — it is applied back-to-front by offset and must stay in source
    // order.
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
