// Spec 064: names the engine leaves as written because they are not anybody's
// secret - a single common English word, the vocabulary every codebase shares
// (src, util, com), and the toolchains a model is told to run. In spec 062's
// sessions 57% of placeholders hid such a word, 56% sat in file paths, and the
// model listed the whole tree to find files it could no longer read.
//
// A name with an inner capital, an underscore or a digit is never ordinary: it
// is a choice somebody made (ledgerEntry, berth_quorum, invoice2). Neither is a
// mixed-case word no dictionary spells (lEdger). Custom rules still win.
import { isKeyword, LANGUAGES } from './languages.js';
import { ENGLISH_WORDS } from './words.js';
/** Words every codebase shares and toolchain names, beyond the dictionary. */
const PROGRAMMING = [
    // Path and package segments
    'src',
    'lib',
    'libs',
    'util',
    'utils',
    'pkg',
    'cmd',
    'bin',
    'dist',
    'tmp',
    'docs',
    'spec',
    'specs',
    'tests',
    'test',
    'main',
    'com',
    'org',
    'net',
    'io',
    'api',
    'apis',
    'app',
    'apps',
    'impl',
    'internal',
    'config',
    'configs',
    'conf',
    'env',
    'envs',
    'dev',
    'prod',
    'vendor',
    'assets',
    'static',
    'public',
    'dto',
    'dao',
    'repo',
    'repos',
    'middleware',
    'handler',
    'handlers',
    'helpers',
    'models',
    'services',
    // Languages and formats
    'java',
    'kotlin',
    'scala',
    'javascript',
    'typescript',
    'python',
    'ruby',
    'php',
    'csharp',
    'rust',
    'golang',
    'sql',
    'json',
    'yaml',
    'yml',
    'xml',
    'html',
    'css',
    'csv',
    'toml',
    'markdown',
    'utf',
    'ascii',
    'http',
    'https',
    'url',
    'urls',
    'uri',
    'uuid',
    'regex',
    'stdin',
    'stdout',
    'stderr',
    'stdlib',
    // Toolchains, test frameworks and package managers
    'node',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'deno',
    'bun',
    'tsc',
    'tsx',
    'vite',
    'vitest',
    'jest',
    'mocha',
    'chai',
    'eslint',
    'prettier',
    'webpack',
    'babel',
    'pytest',
    'unittest',
    'tox',
    'pip',
    'pipenv',
    'poetry',
    'ruff',
    'mypy',
    'black',
    'junit',
    'testng',
    'mockito',
    'hamcrest',
    'mvn',
    'maven',
    'gradle',
    'surefire',
    'minitest',
    'rspec',
    'rake',
    'rails',
    'bundler',
    'gem',
    'gems',
    'cargo',
    'rustc',
    'dotnet',
    'nuget',
    'xunit',
    'nunit',
    'docker',
    'git',
    // Everyday code words no dictionary lists
    'args',
    'kwargs',
    'params',
    'param',
    'attr',
    'attrs',
    'init',
    'ctx',
    'req',
    'res',
    'cfg',
    'impl',
    'enum',
    'enums',
    'int',
    'bool',
    'str',
    'dict',
    'async',
    'await',
    'todo',
    'fixme',
    'func',
    'ptr',
];
let words = null;
function dictionary() {
    if (!words)
        words = new Set([...ENGLISH_WORDS.split(' '), ...PROGRAMMING]);
    return words;
}
/** A single dictionary word, written lower-case, Capitalised or in capitals. */
export function isOrdinaryWord(name) {
    if (!/^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)$/.test(name))
        return false;
    return dictionary().has(name.toLowerCase());
}
// Security review, round 3 (an amendment to spec 064): an ordinary word is
// readable only as an identifier or a path segment. In a value position - a
// string literal; in configuration the text after `=` or `:`, or on the line
// below an empty one; XML element text; a command's `KEY=val` prefix - it is
// masked, whatever its key is called. A list of dangerous credential syntaxes
// could never be complete, so the value positions are listed instead.
// The unit is the whole value up to its delimiter: `"Summer2024!"` is one.
/** A key that names a credential (security review, round 4): one of these
 *  anywhere in it, or a camel, snake or kebab segment that starts or ends with
 *  a short one - `dbPw`, `userPW`, `DBPW`, `--db-password`, `DB_PIN`. */
const CREDENTIAL_WORD = /pass|pwd|secret|token|key|auth|cred|private|salt|jwt|bearer|mnemonic/i;
const CREDENTIAL_SEGMENT = /^(?:pw|otp|pin|seed|cert)|(?:pw|otp|pin|seed|cert)$/;
/** The words for a password and a secret in Polish, German, Spanish, French,
 *  Portuguese, Dutch and Greek, with and without diacritics, and the word for
 *  a key only joined to "api" (alone it is an ordinary word, as `key` is not
 *  for these names). A closed list: another word is added on request. */
const LOCAL_WORD = /(?:has[lł]o|sekret|klucz[_-]?api|kennwort|geheimnis|api[_-]?schl(?:ue|ü)ssel|contrase[nñ]a|clave[_-]?api|mdp|senha|segredo|wachtwoord|kodikos|synthimatiko|κωδικ[οό]ς|συνθηματικ[οό])[0-9]{0,3}$/u;
const QUALIFIER = /^(?:db|database|sql|mysql|pg|postgres|redis|mongo|user|admin|root|api|app|smtp|mail|ftp|ssh|ldap|login|account|master|service|svc|client|server|wifi|my|new|old|default)[_.-]?$/;
/** A name that is one of the words above, or ends in one as a word of its
 *  own: after `_`, `-` or `.`, or at a camel-case joint (`db_haslo`,
 *  `dbHaslo`, `DB_HASLO`). A longer word that only holds one is not
 *  (`geheimnisvoll`, `mdpath`, `senhaForte`). */
function localCredential(name) {
    const lower = name.toLowerCase();
    const m = lower.length === name.length ? LOCAL_WORD.exec(lower) : null;
    if (!m)
        return false;
    if (m.index === 0)
        return true;
    // The Greek word is the word for any code too (a postal code): after
    // another word it is one; only a credential's usual qualifier may stand
    // before it.
    if (/^(?:kodikos|κωδικ)/u.test(m[0]) && !QUALIFIER.test(lower.slice(0, m.index)))
        return false;
    const before = name[m.index - 1];
    if (!/[\p{L}\p{N}]/u.test(before))
        return true;
    const first = name[m.index];
    return first !== first.toLowerCase() && before === before.toLowerCase();
}
/** A name with a letter outside A-Z, which the key patterns below do not
 *  read: found apart, and only for the words above. */
const LOCAL_TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const LOCAL_KEY_STRING = /["'`]([\p{L}\p{N}_.$-]{1,100})["'`]/gu;
const NET_KEY_LOCAL = /(?<![\p{L}\p{N}_$.-])-{0,2}((?=[\w$.-]{0,100}[\u{80}-\u{10ffff}])[\p{L}_$][\p{L}\p{N}_$.-]{0,100})/gu;
const CREDENTIAL = {
    test(name) {
        if (CREDENTIAL_WORD.test(name) || localCredential(name))
            return true;
        for (const segment of name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/))
            if (CREDENTIAL_SEGMENT.test(segment.toLowerCase()))
                return true;
        return false;
    },
};
// Shapes no credential has, as the secret scanner reads them (engine
// 1.12.2): text already masked, a flag's word, a number, a placeholder, a
// command, a CI expression, a YAML alias, a URL without userinfo, a path
// that reads as one (two segments, an extension, or `~/`, `./`, `$HOME/`).
// Such a value is still a value: masked reversibly, never shown.
const NOT_SECRET = /^(?:.{1,2}|(?:__[A-Z][A-Z0-9_]*__\d*)+|true|false|null|none|nil|undefined|yes|no|on|off|~|\d+|<[^<>]*>|\$\(.*|`.*|\$\{\{.*\}\}|\*[\w-]+|[a-z][\w+.-]*:\/\/[^\s@]*|(?:~|\.{1,2}|\$\{?\w+\}?)?(?:\/[\w.@~+-]+){2,}\/?|(?:~|\.{1,2}|\$\{?\w+\}?)?\/[\w@~+-]+\.\w{1,8}|(?:~|\.{1,2}|\$\{?\w+\}?)\/[\w.@~+-]+)$/i;
// An unquoted `$NAME` or `${NAME}` is a reference to another variable; a
// quoted one (`"$unshine"`) is a value.
const REFERENCE = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/;
// A path keeps 064's readable segments: no space, no scheme, a separator.
const PATH = /^[\w.@~+-]*[\\/][\w.@~+\\/-]*$/;
const QUOTED = /(?<![A-Za-z0-9])(["'`])([^\n]{0,4096}?)\1/g;
const KEY_TOKEN = /[A-Za-z_$][\w$]*/g;
const KEY_STRING = /["'`]([\w.$-]{1,100})["'`]/g;
// A language's own word names nothing (`private`, `const`, `str`) - but
// `key`, a TypeScript keyword, is a key's name all the same.
function keyword(word, language) {
    if (/^keys?$/i.test(word))
        return false;
    return language ? isKeyword(word, language) : LANGUAGES.some((l) => isKeyword(word, l));
}
/** Whether the value at `at` sits under a credential key: any name, or any
 *  key-shaped string, between it and the start of its statement or pair, at
 *  most 256 characters back on its line (`password: Optional[str] = `,
 *  `define('DB_PASSWORD', `, `secrets = Map.of("k", `). A comma ends the
 *  search only where a new pair starts after it (`"pass": "x", "color": `). */
function credentialBefore(text, at, language, code = false) {
    let prefix = lineBefore(text, at);
    // In code, a literal first on its line is the value the line above asks for.
    if (code && prefix.trim() === '')
        prefix = lineAbove(text, at - prefix.length) ?? prefix;
    // A C# property's accessors stand between its name and its value.
    prefix = prefix.replace(ACCESSORS, ' ');
    const statement = Math.max(prefix.lastIndexOf(';'), prefix.lastIndexOf('{'), prefix.lastIndexOf('}'));
    prefix = prefix.slice(statement + 1);
    // From the right; lastIndexOf(',', -1) would find index 0 again.
    for (let c = prefix.lastIndexOf(','); c !== -1; c = c > 0 ? prefix.lastIndexOf(',', c - 1) : -1)
        if (/[:=]/.test(prefix.slice(c + 1))) {
            prefix = prefix.slice(c + 1);
            break;
        }
    // A call's first argument is keyed by the call: `setPassword("...")` is,
    // `os.getenv("SECRET_KEY")` looks a name up.
    const call = /([A-Za-z_$][\w$]*)[ \t]*\([ \t]*$/.exec(prefix);
    if (call)
        return CREDENTIAL.test(call[1]) && !keyword(call[1], language) ? call[1] : null;
    // In a tag, `key="..."` names the entry (`<add key="Theme" value="dark"/>`).
    if (/<[\w.:-]+(?:\s[^<>]*)?\s(?:key|name|id)[ \t]*=[ \t]*$/i.test(prefix))
        return null;
    for (const m of prefix.matchAll(KEY_STRING))
        if (CREDENTIAL.test(m[1]))
            return m[1];
    for (const [t] of prefix.replace(STRING, ' ').matchAll(KEY_TOKEN))
        if (CREDENTIAL.test(t) && !keyword(t, language))
            return t;
    // Only where a letter outside A-Z stands: every other name was read above.
    if (!/[\u0080-\uffff]/.test(prefix))
        return null;
    for (const m of prefix.matchAll(LOCAL_KEY_STRING))
        if (localCredential(m[1]))
            return m[1];
    for (const [t] of prefix.replace(STRING, ' ').matchAll(LOCAL_TOKEN))
        if (localCredential(t))
            return t;
    return null;
}
const STRING = /(["'`])[^"'`]*\1/g;
const ACCESSORS = /\{\s*(?:get|set|init)\b[^{}]*\}/g;
/** The line above the one that starts at `lineStart`, when it leaves its
 *  value for the next line: it ends in `=` or `= (`, or is a property's name
 *  and colon. Any other line above is a statement of its own (a comparison,
 *  an arrow, a block's header, a case label) or a call, whose argument on the
 *  next line may be a message or a name. */
function lineAbove(text, lineStart) {
    if (lineStart === 0 || text[lineStart - 1] !== '\n')
        return null;
    const above = lineBefore(text, lineStart - 1).trimEnd();
    return /(?<![=!<>])=(?:[ \t]*\()?$/.test(above) ||
        /^[\s{,[(]*["'`]?[^\s:"'`]+["'`]?[ \t]*:$/.test(above)
        ? above
        : null;
}
const CALL_ARGUMENT = /[A-Za-z_$][\w$]*[ \t]*\([ \t]*["'`]{0,2}$/;
/** Where adjacent string literals are one string without a `+`. */
const JOINS_ADJACENT = new Set(['python', 'ruby', 'c', 'sql']);
const BETWEEN_LITERALS = /^["'`]{1,3}[ \t]*(\+?)[ \t]*(\\?)\r?\n[ \t]*(\+?)[ \t]*[A-Za-z]{0,2}["'`]{1,3}$/;
/** Whether the literal that starts at `start` carries on, over a line break,
 *  the literal that ended at `end`: joined by `+`, by a backslash at the line
 *  end, or side by side where the language joins those. Never a literal that
 *  is a key (`"label": ...`). On one line the key search has read both. */
function continuesLiteral(text, end, start, after, language) {
    if (start - end > 200)
        return false;
    const m = BETWEEN_LITERALS.exec(text.slice(end, start));
    if (!m)
        return false;
    if (!m[1] && !m[2] && !m[3] && !(language && JOINS_ADJACENT.has(language)))
        return false;
    return !/^["'`]{0,3}[ \t]*:/.test(text.slice(after, after + 8));
}
/** The text before `at` on its line, at most 256 characters: bounded, so
 *  many values on one long line stay linear. */
function lineBefore(text, at) {
    const window = text.slice(Math.max(0, at - 256), at);
    return window.slice(window.lastIndexOf('\n') + 1);
}
/** Inside a `$( ... )` its line opened and has not closed. */
function inCommand(text, at) {
    const before = lineBefore(text, at);
    return (before.match(/\$\(/g)?.length ?? 0) > (before.match(/\)/g)?.length ?? 0);
}
// In code, an unquoted call or member access (`getToken()`, `settings.token`)
// reads a value; it is not one. The whole value, and only in code: in
// configuration `Xk9m.Q2v` is a password (security review, round 4).
const CALL_OR_MEMBER = /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)+(?:\([^()]*\))?|\([^()]*\))[,;]?$/;
/** A value that may be a secret: one no shape above rules out. */
function secretShaped(value, quoted, code = false) {
    const v = value.trim();
    return (v !== '' &&
        !NOT_SECRET.test(v) &&
        (quoted || (!REFERENCE.test(v) && !(code && CALL_OR_MEMBER.test(v)))));
}
// The credential net (security review, round 4): in every file that is not
// code, a name holding a credential word, any separator, and the value up to
// its delimiter (netValueEnd). Fail closed: only netExempt's shapes are left.
// A name is a whole token (`--db-password`, `_authToken`, `db.password`); a
// `(`, `[` or `,` separates only a quoted value, so `[token, setToken]` in
// command output is not a pair.
const NET_KEY = /(?<![\w$.-])-{0,2}([A-Za-z_$][\w$.-]{0,100})/g;
const NET_TAIL = /(?:[ \t]|\\\r?\n|=>|->|:=|[=:"'`>]|<!\[CDATA\[|[([,](?=[ \t]*["'`])){1,40}(?=\S)/y;
// The start of a line of code, for the net over code only guessed at.
const CODE_START = /(?:^|\n)[ \t]*(?:(?:export|set)[ \t]+)?-{0,2}$/;
const CODE_LINE = /\n[ \t]*(?:(?:export|set)[ \t]+)?-{0,2}$/;
const PGPASS_SHAPE = /^[^:\s]+:(?:\d{1,5}|\*):[^:\s]+:[^:\s]+:(\S+)$/dgm;
// `.pgpass`: host:port:database:user:password, one entry a line.
const PGPASS_LINE = /^(?![ \t]*#)(?:[^:\n]*:){4}([^\n]+)$/dgm;
// `key=value` pairs inside a value: a connection string, a query string.
const INNER = /(?<![\w.$-])([A-Za-z_][\w.-]{0,100})[ \t]*[=:][ \t]*([^\s;&,'"<>]+)/dg;
// A URL read as a pair has its scheme for a key (`https` = the rest), so the
// pairs of its query and fragment lie inside that value: a pair there starts
// after a `?` or `#`.
const INNER_KEY = /(?<![\w.$-])([A-Za-z_][\w.-]{0,100})[=:]/g;
const QUERY_MARK = /[?#]/g;
/** The first credential-named pair after a `?` or `#` in the value of a pair
 *  that is not one: its key, and where its value starts. That value runs to
 *  the end of `value`, as the enclosing pair's does. Read as INNER would read
 *  what follows each mark in turn, in one forward walk. */
function pairAfterMark(value) {
    let from = 0;
    for (;;) {
        QUERY_MARK.lastIndex = from;
        if (!QUERY_MARK.test(value))
            return null;
        INNER_KEY.lastIndex = QUERY_MARK.lastIndex;
        const m = INNER_KEY.exec(value);
        if (!m || INNER_KEY.lastIndex >= value.length)
            return null;
        if (CREDENTIAL.test(m[1]))
            return { key: m[1], at: INNER_KEY.lastIndex };
        from = INNER_KEY.lastIndex;
    }
}
// Configuration lines. Each starts at a line start, every run is bounded or
// ends at the line's end, and no quantified group nests another: linear.
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]{0,200})[ \t]*=([^\n]*)$/dgm;
const INI_LINE = /^[ \t]*["']?([A-Za-z_$][\w.$-]{0,200})["']?[ \t]*(?:[:?+]?=|:)([^\n]*)$/dgm;
const INI_KEY = /^[ \t]*["']?[A-Za-z_$][\w.$-]{0,200}["']?[ \t]*(?:[:?+]?=|:)/;
const YAML_LINE = /^([ \t]*)(?:-[ \t]+)?["']?([^\s:"'#-][^:"'\n]{0,200}?)["']?[ \t]*:((?:[ \t][^\n]*)?)$/dgm;
const YAML_SCALAR = /^[ \t]*(?!-[ \t]|-$|#|---|\.\.\.)([^\n]+)$/dgm;
const YAML_ITEM = /^[ \t]*-[ \t]+([^\n]*)$/dgm;
const SHELL_PAIR = /(?<![^\s;&|(])(?:export[ \t]+)?([A-Za-z_]\w{0,200})=("[^"\n]*"|'[^'\n]*'|[^\s;&|]*)/dg;
const DOCKER_ENV = /^[ \t]*ENV[ \t]+([A-Za-z_]\w{0,200})[ \t]+([^\n=]+)$/dgm;
const XML_TEXT = /<([A-Za-z_][\w.:-]{0,100})([^<>]{0,2000})>([^<]+)<\//dg;
// A block scalar's header as the whole of a key's value: `|`, `>-`, `|2`,
// behind a tag or an anchor, before a comment.
const BLOCK_HEADER = /^[ \t]*(?:[&!]\S*[ \t]+)*[|>][-+0-9]{0,2}[ \t]*(?:#[^\n]*)?\r?$/;
// A line that starts a key of its own: the one grammar YAML keys are read
// by, so a quote never runs past a line the reading above takes for a key.
const STARTS_KEY = new RegExp(YAML_LINE.source);
// A comment starts after a space; a glued `#` is part of the value.
const HASH = /[ \t]#/;
const HASH_OR_SEMICOLON = /[ \t][#;]/;
const XML_KEY_ATTR = /(?:^|\s)(?:key|name|id)[ \t]*=[ \t]*["']([^"']*)["']/g;
/** The value in `raw` at `offset`: its comment and quotes taken off, and in
 *  YAML its anchor and tag; a block header has its value on the lines below. */
function trimmed(raw, offset, comment, yaml = false, stop = null) {
    let end = raw.length;
    for (const re of [comment, stop]) {
        const at = re ? raw.slice(0, end).search(re) : -1;
        if (at !== -1)
            end = at;
    }
    let start = 0;
    while (start < end && /\s/.test(raw[start]))
        start++;
    while (end > start && /\s/.test(raw[end - 1]))
        end--;
    if (yaml) {
        const props = /^(?:[&!]\S*[ \t]+)*(?:[&!]\S*$)?/.exec(raw.slice(start, end))[0];
        start += props.length;
        if (/^[|>][-+]?\d?[-+]?$/.test(raw.slice(start, end)))
            return null;
    }
    const quoted = end - start >= 2 && /["'`]/.test(raw[start]) && raw[end - 1] === raw[start];
    if (quoted) {
        // A TOML or Python triple-quoted string is quoted by all three.
        const q = raw[start].repeat(3);
        const triple = end - start >= 6 && raw.startsWith(q, start) && raw.startsWith(q, end - 3);
        start += triple ? 3 : 1;
        end -= triple ? 3 : 1;
    }
    return end > start ? { start: offset + start, end: offset + end, quoted } : null;
}
/** The net's only exemptions (ruling, round 4): text already masked, one
 *  or two characters, a `$NAME` reference, a language keyword, and in code a
 *  call or member access that is the whole value. */
function netExempt(value, calls, language) {
    return (value.length <= 2 ||
        /^(?:__[A-Z][A-Z0-9_]*__\d*)+$/.test(value) ||
        REFERENCE.test(value) ||
        keyword(value, language) ||
        (calls && CALL_OR_MEMBER.test(value)));
}
/** Where a net value starting at `s` ends. In quotes, at the closing quote;
 *  as element text, at `<`; in CDATA, at `]]>`. Otherwise at the next
 *  whitespace - or at a quote, brace (or its pair's comma) or paren opened
 *  before the key on its line and still open (a `"KEY=value"` string, an
 *  object, a call). However long: each character is read once. */
function netValueEnd(text, key, s, sep) {
    const end = netValueStop(text, key, s, sep);
    // A command, a CI expression or a `<placeholder>` is one value however many
    // words it holds: redacted to its close, never cut at a space inside it.
    const limit = text.length;
    const opener = /^(?:\$\(|\$\{\{|<|`)/.exec(text.slice(s, s + 3))?.[0];
    if (!opener)
        return end;
    let depth = 0;
    let n = s;
    for (; n < limit && text[n] !== '\n'; n++) {
        const c = text[n];
        if (opener === '$(') {
            if (c === '(')
                depth++;
            else if (c === ')' && --depth === 0)
                return Math.max(end, n + 1);
        }
        else if (opener === '${{') {
            if (c === '}' && text[n + 1] === '}' && n > s + 2)
                return Math.max(end, n + 2);
        }
        else if (c === (opener === '<' ? '>' : '`') && n > s)
            return Math.max(end, n + 1);
    }
    // Never closed: to the end of the line, failing closed.
    return Math.max(end, n);
}
function netValueStop(text, key, s, sep) {
    const limit = text.length;
    // Character by character: the cost is the value's own length.
    const until = (stop) => {
        let n = s;
        while (n < limit && text[n] !== '\n' && !stop.includes(text[n]))
            n++;
        return n;
    };
    const last = sep[sep.length - 1];
    if (/["'`]/.test(last))
        return until(last);
    if (sep.endsWith('<![CDATA[')) {
        const end = until('');
        const close = text.slice(s, end).indexOf(']]>');
        return close === -1 ? end : s + close;
    }
    if (last === '>')
        return until('<');
    const line = lineBefore(text, key);
    const open = (o, c) => line.split(o).length > line.split(c).length;
    let stop = ' \t\r\f\v';
    for (const q of ['"', "'", '`'])
        if ((line.split(q).length - 1) % 2 === 1)
            stop += q;
    if (open('{', '}'))
        stop += '},';
    if (open('(', ')'))
        stop += ')';
    if (open('[', ']'))
        stop += ']';
    return until(stop);
}
/** Every value position in `text`, sorted by start. Spans may nest: a
 *  connection string's `password=...` lies inside its string. */
export function valueSpans(text, scan = {}) {
    const out = [];
    const kind = scan.kind;
    // In code an unquoted call or member access reads a value; never elsewhere.
    const calls = kind === 'code';
    // Under a credential key a value is never a readable path.
    const add = (start, end, key, quoted, grammar, module = false) => {
        const value = text.slice(start, end);
        const keyed = key !== null;
        const credential = keyed && secretShaped(value, quoted, calls);
        const span = {
            start,
            end,
            value,
            credential,
            path: !keyed && (module || PATH.test(value)),
        };
        if (keyed)
            Object.assign(span, { key, quoted, grammar });
        out.push(span);
    };
    const named = (key) => key !== undefined && CREDENTIAL.test(key) ? key : null;
    const strings = scan.strings ??
        [...text.matchAll(QUOTED)].map((m) => ({
            start: m.index + 1,
            end: m.index + 1 + m[2].length,
        }));
    let joined = null;
    for (const s of strings) {
        // A module is a path; a shell's backticks run a command.
        const shell = kind === 'shell' || kind === 'dotenv';
        const command = shell && (text[s.start - 1] === '`' || inCommand(text, s.start));
        let key = s.module || command ? null : credentialBefore(text, s.start - 1, scan.language, calls);
        // A credential's literal carried on over a line break is the same value.
        if (key === null &&
            joined !== null &&
            calls &&
            !s.module &&
            continuesLiteral(text, joined.end, s.start, s.end, scan.language))
            key = joined.key;
        // Not a call's argument: joined literals there are a message as often
        // as a value (`throw new KeyError('...' + '...')`).
        joined =
            key === null || CALL_ARGUMENT.test(lineBefore(text, s.start - 1)) ? null : { end: s.end, key };
        add(s.start, s.end, key, true, 'string', s.module);
    }
    const any = kind === undefined;
    // In text of no known kind a line holds several pairs: `,` and `;` end one.
    const end = any ? /[,;]/ : null;
    const line = (re, key, value, comment, grammar) => {
        for (const m of text.matchAll(re)) {
            const raw = m[value];
            if (raw === undefined)
                continue;
            const at = m.indices[value][0];
            const v = trimmed(raw, at, comment, false, end);
            if (v)
                add(v.start, v.end, key > 0 ? named(m[key]) : null, v.quoted, grammar);
        }
    };
    // A config file written in its neighbour's syntax keeps its values too: a
    // `key: value` in a dotenv file, a `KEY=value` in YAML.
    if (any || kind === 'dotenv' || kind === 'yaml')
        line(ENV_LINE, 1, 2, HASH, 'env');
    if (any || kind === 'ini' || kind === 'dotenv')
        line(INI_LINE, 1, 2, HASH_OR_SEMICOLON, 'ini');
    // An INI or properties value that ends in a backslash carries on over the
    // next line: under a credential key those lines are the value too, up to a
    // line that starts a key of its own. Each line is read once.
    if (kind === 'ini') {
        let done = 0;
        for (const m of text.matchAll(INI_LINE)) {
            const key = named(m[1]);
            if (key === null || m.index < done || !/(?<!\\)(?:\\\\)*\\[ \t\r]*$/.test(m[2]))
                continue;
            let at = m.index + m[0].length + 1;
            while (at < text.length) {
                const nl = text.indexOf('\n', at);
                const next = text.slice(at, nl === -1 ? text.length : nl);
                if (INI_KEY.test(next))
                    break;
                const more = /\\[ \t\r]*$/.test(next);
                const lead = next.length - next.trimStart().length;
                // With its backslash, as the first line's value is read.
                const end = next.trimEnd().length;
                if (end > lead)
                    add(at + lead, at + end, key, false, 'ini');
                at += next.length + 1;
                if (!more)
                    break;
            }
            done = at;
        }
    }
    if (any || kind === 'shell') {
        line(SHELL_PAIR, 1, 2, null, 'shell');
        line(DOCKER_ENV, 1, 2, HASH, 'shell');
    }
    if (any || kind === 'yaml') {
        // A list item is a value; a `KEY=value` in it is found as a pair inside.
        line(YAML_ITEM, 0, 1, HASH, 'yaml');
        // A key with nothing after it may have its value on the line below; a
        // k8s env entry's `value:` belongs to the `name:` above it.
        let previous = null;
        const keys = new Set();
        let scalarEnd = 0;
        /** The lines of a block scalar under `key`: every line from `from` on
         *  that is indented deeper than its key, blank lines passed over. Each
         *  line is its own value. Answers where the block ends. */
        const blockLines = (from, indent, key, grammar) => {
            let at = from;
            while (at < text.length) {
                const nl = text.indexOf('\n', at);
                const line = text.slice(at, nl === -1 ? text.length : nl);
                const lead = line.length - line.trimStart().length;
                if (lead < line.length) {
                    if (lead <= indent)
                        break;
                    add(at + lead, at + line.trimEnd().length, key, false, grammar);
                }
                at += line.length + 1;
            }
            return at;
        };
        /** The lines a plain scalar under `key` carries on over: each line from
         *  `from` on that is indented deeper than the key and is neither a key, a
         *  list item nor a comment. Answers where they end. */
        const plainLines = (from, indent, key, grammar) => {
            let at = from;
            while (at < text.length) {
                const nl = text.indexOf('\n', at);
                const line = text.slice(at, nl === -1 ? text.length : nl);
                const lead = line.length - line.trimStart().length;
                if (lead < line.length) {
                    if (lead <= indent || /^[-#]/.test(line.slice(lead)) || STARTS_KEY.test(line))
                        break;
                    add(at + lead, at + line.trimEnd().length, key, false, grammar);
                }
                at += line.length + 1;
            }
            return at;
        };
        /** A quoted scalar that opens at `start` and closes on a later line: its
         *  contents, line by line, under `key`. Answers where it closes, or 0 when
         *  it closes on its own line, never closes within 16 KB, or a line that
         *  starts a key comes first - a stray quote, read as before. */
        const quotedLines = (start, key, grammar) => {
            const quote = text[start];
            if (quote !== '"' && quote !== "'")
                return 0;
            /** Where the quote closes in `line`, from `from` on, or -1. */
            const closing = (line, from) => {
                for (let i = from; i < line.length; i++) {
                    if (quote === '"' && line[i] === '\\')
                        i++;
                    else if (line[i] === quote) {
                        if (quote === "'" && line[i + 1] === "'")
                            i++;
                        else
                            return i;
                    }
                }
                return -1;
            };
            let nl = text.indexOf('\n', start);
            if (nl === -1 || closing(text.slice(start, nl), 1) !== -1)
                return 0;
            const lines = [
                [start + 1, start + text.slice(start, nl).trimEnd().length],
            ];
            const limit = Math.min(text.length, start + 16384);
            for (let at = nl + 1; at < limit; at = nl + 1) {
                nl = text.indexOf('\n', at);
                if (nl === -1)
                    nl = text.length;
                const line = text.slice(at, nl);
                if (STARTS_KEY.test(line))
                    return 0;
                const lead = line.length - line.trimStart().length;
                const close = closing(line, 0);
                if (close === -1) {
                    lines.push([at + lead, at + line.trimEnd().length]);
                    continue;
                }
                lines.push([at + lead, at + close]);
                for (const [s, e] of lines)
                    if (e > s)
                        add(s, e, key, false, grammar);
                return at + close;
            }
            return 0;
        };
        for (const m of text.matchAll(YAML_LINE)) {
            keys.add(m.index);
            const indent = m[1].length;
            const key = m[2];
            const entry = previous && /^value$/i.test(key) && /^name$/i.test(previous.key);
            const k8s = !CREDENTIAL.test(key) && entry === true ? named(previous.value) : null;
            const credential = k8s ?? named(key);
            const grammar = k8s === null ? 'yaml' : 'k8s';
            const raw = m[3] ?? '';
            const v = trimmed(raw, m.indices[3]?.[0] ?? m.index + m[0].length, HASH, true, end);
            // Under a credential key the whole value is the credential: a quoted
            // scalar to its closing quote on a later line, a block scalar to its
            // last line. A line inside one opens no other.
            const inside = m.index < scalarEnd;
            const closes = v && credential !== null && !v.quoted && !inside
                ? quotedLines(v.start, credential, grammar)
                : 0;
            if (closes > 0)
                scalarEnd = closes;
            else if (v) {
                add(v.start, v.end, credential, v.quoted, grammar);
                // A plain scalar carries on over the lines indented deeper than its key.
                if (credential !== null && kind === 'yaml' && !v.quoted && !inside)
                    scalarEnd = plainLines(m.index + m[0].length + 1, indent, credential, grammar);
            }
            else if (credential !== null && BLOCK_HEADER.test(raw)) {
                if (!inside)
                    scalarEnd = blockLines(m.index + m[0].length + 1, indent, credential, grammar);
            }
            else {
                const next = m.index + m[0].length + 1;
                const nl = text.indexOf('\n', next);
                const below = text.slice(next, nl === -1 ? text.length : nl);
                const lead = below.length - below.trimStart().length;
                if (lead > indent && !/^[ \t]*(?:-|#|[^\s:]+:(?:\s|$))/.test(below)) {
                    const w = trimmed(below, next, HASH, true);
                    if (w)
                        add(w.start, w.end, credential, w.quoted, grammar);
                    // A plain scalar that starts below its key carries on the same way.
                    if (w && credential !== null && kind === 'yaml' && !w.quoted && !inside)
                        scalarEnd = plainLines(next + below.length + 1, indent, credential, grammar);
                }
            }
            previous = { indent, key, value: v ? text.slice(v.start, v.end) : '' };
        }
        // Any other line of a YAML file is a scalar: a block's body, a plain
        // value over several lines, a document that is one value.
        if (kind === 'yaml')
            for (const m of text.matchAll(YAML_SCALAR)) {
                if (keys.has(m.index))
                    continue;
                const v = trimmed(m[1], m.indices[1][0], HASH, true);
                if (v)
                    add(v.start, v.end, null, v.quoted, 'yaml');
            }
    }
    // Element text, in every kind: XML embedded in code, JSX.
    {
        for (const m of text.matchAll(XML_TEXT)) {
            const [s] = m.indices[3];
            const v = trimmed(m[3], s, null);
            if (!v)
                continue;
            let credential = named(m[1]);
            for (const a of m[2].matchAll(XML_KEY_ATTR))
                credential ??= named(a[1]);
            add(v.start, v.end, credential, false, 'xml');
        }
    }
    // A bare name after a credential key, in text of no known kind.
    if (any) {
        for (const m of text.matchAll(BARE)) {
            const [s, e] = m.indices[2];
            const value = m[2];
            if (!CREDENTIAL.test(m[1]) || !secretShaped(value, false) || keyword(value, scan.language))
                continue;
            const span = { start: s, end: e, value, credential: true, path: false, bare: true };
            out.push(Object.assign(span, { key: m[1], quoted: false, grammar: 'bare' }));
        }
    }
    if (kind !== 'code' || scan.net) {
        // In code only guessed at, the net reads a line's own `KEY=value` (a
        // Makefile, a pasted .env); a name's type (`DB_PASSWORD: Optional[str]`)
        // and a statement (`const monkey = ledger`) are code's.
        const guessed = kind === 'code';
        // Names in A-Z, then the names of the other-language list that are not.
        for (const [keys, names] of [
            [NET_KEY, (name) => CREDENTIAL.test(name)],
            [NET_KEY_LOCAL, localCredential],
        ]) {
            let covered = 0;
            for (const k of text.matchAll(keys)) {
                const at = k.index;
                const keyEnd = at + k[0].length;
                // A placeholder already in the text (`__REDACTED_CREDENTIAL_1__`) names nothing.
                if (at < covered || /__[A-Z]/.test(k[1]) || !names(k[1]))
                    continue;
                if (guessed &&
                    !(at > 64 ? CODE_LINE : CODE_START).test(text.slice(Math.max(0, at - 64), at)))
                    continue;
                NET_TAIL.lastIndex = keyEnd;
                const m = NET_TAIL.exec(text);
                if (!m)
                    continue;
                const s = keyEnd + m[0].length;
                const sep = m[0];
                if (guessed && !sep.includes('='))
                    continue;
                const e = netValueEnd(text, at, s, sep);
                const value = text.slice(s, e);
                covered = e;
                if (netExempt(value, calls, scan.language))
                    continue;
                const quoted = /["'`]$/.test(sep);
                const span = { start: s, end: e, value, credential: true, path: false };
                // `KEY=value` written tight is a pair (a URL's query, a connection
                // string); with spaces around it, perhaps an assignment in code.
                const grammar = /^[=:]$/.test(sep) ? 'pair' : 'net';
                out.push(Object.assign(span, { key: k[1], quoted, grammar }));
            }
        }
    }
    // `host:port:db:user:password` in text of no kind: a .pgpass line.
    if (kind === undefined || scan.net)
        for (const m of text.matchAll(PGPASS_SHAPE)) {
            const [s, e] = m.indices[1];
            if (secretShaped(m[1], false))
                out.push(pgpass(s, e, m[1]));
        }
    if (kind === 'pgpass')
        for (const m of text.matchAll(PGPASS_LINE)) {
            const [s, e] = m.indices[1];
            if (!netExempt(m[1], false, scan.language))
                out.push(pgpass(s, e, m[1]));
        }
    // Pairs inside every value found so far.
    for (const span of out.slice()) {
        if (span.credential)
            continue;
        for (const m of span.value.matchAll(INNER)) {
            const [s, e] = m.indices[2];
            if (CREDENTIAL.test(m[1]))
                add(span.start + s, span.start + e, m[1], false, 'inner');
            else {
                const inside = pairAfterMark(m[2]);
                if (inside)
                    add(span.start + s + inside.at, span.start + e, inside.key, false, 'inner');
            }
        }
    }
    // A value written as one wins over the same text read as a bare name.
    return out.sort((a, b) => a.start - b.start || b.end - a.end || Number(!!a.bare) - Number(!!b.bare));
}
// A .pgpass line's last field is its password.
const pgpass = (start, end, value) => ({
    start,
    end,
    value,
    credential: true,
    path: false,
    key: 'password',
    quoted: false,
    grammar: 'pgpass',
});
const BARE = /(?<![\w$.-])["'`]?([A-Za-z_$][\w$.-]{0,100})["'`]?\]?[ \t]*(?:=>|:=|=(?![=~>])|:(?!:))[ \t]*([A-Za-z_$][\w$]{0,255})(?=[ \t]*(?:[,;})\]#<]|\/\/|\r?$))/dgm;
/** The credential values among `spans`, never overlapping: the first wins. */
export function credentialsAmong(spans) {
    const out = [];
    for (const s of spans)
        if (s.credential && (!out.length || s.start >= out[out.length - 1].end))
            out.push(s);
    return out;
}
