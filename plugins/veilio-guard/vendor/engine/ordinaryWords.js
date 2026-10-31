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
/** A key that names a credential: one of these anywhere in it. */
const CREDENTIAL = /pass|pwd|secret|token|key|auth|cred|private|salt|(?<![a-z])pw(?![a-z])/i;
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
function keyword(word, language) {
    if (CREDENTIAL.test(word))
        return false;
    return language ? isKeyword(word, language) : LANGUAGES.some((l) => isKeyword(word, l));
}
/** Whether the value at `at` sits under a credential key: the last name, or
 *  the last key-shaped string, between it and the statement or argument
 *  boundary before it (`password: string = `, `<add key="DbPassword" value=`).
 *  Right after an argument's comma, only the string before it is the key
 *  (`define('DB_PASSWORD', `). At most 256 characters back. */
function credentialBefore(text, at, language) {
    const from = Math.max(0, at - 256);
    let i = at - 1;
    let words = false;
    let argument = false;
    for (; i >= from; i--) {
        const c = text[i];
        if (c === '\n')
            break;
        if (';{}(,<>['.includes(c)) {
            if (words || argument)
                break;
            argument = c === ',';
            if (!argument)
                break;
        }
        else if (/\w/.test(c))
            words = true;
    }
    const prefix = text.slice(i + 1, at);
    let quoted;
    for (const m of prefix.matchAll(KEY_STRING))
        quoted = m[1];
    if (argument)
        return CREDENTIAL.test(quoted ?? '');
    // In a tag, `key="..."` names the entry (`<add key="Theme" value="dark"/>`).
    if (text[i] === '<' && /(?:^|\s)(?:key|name|id)[ \t]*=[ \t]*$/i.test(prefix))
        return false;
    let name;
    for (const [t] of prefix.replace(STRING, ' ').matchAll(KEY_TOKEN))
        if (!keyword(t, language))
            name = t;
    return CREDENTIAL.test(name ?? '') || CREDENTIAL.test(quoted ?? '');
}
const STRING = /(["'`])[^"'`]*\1/g;
/** A value that may be a secret: one no shape above rules out. */
function secretShaped(value, quoted) {
    const v = value.trim();
    return v !== '' && !NOT_SECRET.test(v) && (quoted || !REFERENCE.test(v));
}
// `key=value` pairs inside a value: a connection string, a query string.
const INNER = /(?<![\w.$-])([A-Za-z_][\w.-]{0,100})[ \t]*[=:][ \t]*([^\s;&,'"<>]+)/dg;
// Configuration lines. Each starts at a line start, every run is bounded or
// ends at the line's end, and no quantified group nests another: linear.
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]{0,200})[ \t]*=([^\n]*)$/dgm;
const INI_LINE = /^[ \t]*["']?([A-Za-z_$][\w.$-]{0,200})["']?[ \t]*[=:]([^\n]*)$/dgm;
const YAML_LINE = /^([ \t]*)(?:-[ \t]+)?["']?([^\s:"'#-][^:"'\n]{0,200}?)["']?[ \t]*:((?:[ \t][^\n]*)?)$/dgm;
const YAML_SCALAR = /^[ \t]*(?!-[ \t]|-$|#|---|\.\.\.)([^\n]+)$/dgm;
const YAML_ITEM = /^[ \t]*-[ \t]+([^\n]*)$/dgm;
const SHELL_PAIR = /(?<![^\s;&|(])(?:export[ \t]+)?([A-Za-z_]\w{0,200})=("[^"\n]*"|'[^'\n]*'|[^\s;&|]*)/dg;
const DOCKER_ENV = /^[ \t]*ENV[ \t]+([A-Za-z_]\w{0,200})[ \t]+([^\n=]+)$/dgm;
const XML_TEXT = /<([A-Za-z_][\w.:-]{0,100})([^<>]{0,2000})>([^<]+)<\//dg;
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
        start++;
        end--;
    }
    return end > start ? { start: offset + start, end: offset + end, quoted } : null;
}
/** Every value position in `text`, sorted by start. Spans may nest: a
 *  connection string's `password=...` lies inside its string. */
export function valueSpans(text, scan = {}) {
    const out = [];
    const kind = scan.kind;
    // Under a credential key a value is never a readable path.
    const add = (start, end, keyed, quoted, module = false) => {
        const value = text.slice(start, end);
        const credential = keyed && secretShaped(value, quoted);
        out.push({ start, end, value, credential, path: !keyed && (module || PATH.test(value)) });
    };
    const strings = scan.strings ??
        [...text.matchAll(QUOTED)].map((m) => ({
            start: m.index + 1,
            end: m.index + 1 + m[2].length,
        }));
    for (const s of strings) {
        // A module is a path; a shell's backticks run a command.
        const command = text[s.start - 1] === '`' && (kind === 'shell' || kind === 'dotenv');
        const keyed = !s.module && !command && credentialBefore(text, s.start - 1, scan.language);
        add(s.start, s.end, keyed, true, s.module);
    }
    const any = kind === undefined;
    // In text of no known kind a line holds several pairs: `,` and `;` end one.
    const end = any ? /[,;]/ : null;
    const line = (re, key, value, comment) => {
        for (const m of text.matchAll(re)) {
            const raw = m[value];
            if (raw === undefined)
                continue;
            const at = m.indices[value][0];
            const v = trimmed(raw, at, comment, false, end);
            if (v)
                add(v.start, v.end, key > 0 && CREDENTIAL.test(m[key]), v.quoted);
        }
    };
    // A config file written in its neighbour's syntax keeps its values too: a
    // `key: value` in a dotenv file, a `KEY=value` in YAML.
    if (any || kind === 'dotenv' || kind === 'yaml')
        line(ENV_LINE, 1, 2, HASH);
    if (any || kind === 'ini' || kind === 'dotenv')
        line(INI_LINE, 1, 2, HASH_OR_SEMICOLON);
    if (any || kind === 'shell') {
        line(SHELL_PAIR, 1, 2, null);
        line(DOCKER_ENV, 1, 2, HASH);
    }
    if (any || kind === 'yaml') {
        // A list item is a value; a `KEY=value` in it is found as a pair inside.
        line(YAML_ITEM, 0, 1, HASH);
        // A key with nothing after it may have its value on the line below; a
        // k8s env entry's `value:` belongs to the `name:` above it.
        let previous = null;
        const keys = new Set();
        for (const m of text.matchAll(YAML_LINE)) {
            keys.add(m.index);
            const indent = m[1].length;
            const key = m[2];
            const named = previous && /^value$/i.test(key) && /^name$/i.test(previous.key);
            const credential = CREDENTIAL.test(key) || (named === true && CREDENTIAL.test(previous.value));
            const raw = m[3] ?? '';
            const v = trimmed(raw, m.indices[3]?.[0] ?? m.index + m[0].length, HASH, true, end);
            if (v)
                add(v.start, v.end, credential, v.quoted);
            else {
                const next = m.index + m[0].length + 1;
                const nl = text.indexOf('\n', next);
                const below = text.slice(next, nl === -1 ? text.length : nl);
                const lead = below.length - below.trimStart().length;
                if (lead > indent && !/^[ \t]*(?:-|#|[^\s:]+:(?:\s|$))/.test(below)) {
                    const w = trimmed(below, next, HASH, true);
                    if (w)
                        add(w.start, w.end, credential, w.quoted);
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
                    add(v.start, v.end, false, v.quoted);
            }
    }
    // Element text, in every kind: XML embedded in code, JSX.
    {
        for (const m of text.matchAll(XML_TEXT)) {
            const [s] = m.indices[3];
            const v = trimmed(m[3], s, null);
            if (!v)
                continue;
            let credential = CREDENTIAL.test(m[1]);
            for (const a of m[2].matchAll(XML_KEY_ATTR))
                credential ||= CREDENTIAL.test(a[1]);
            add(v.start, v.end, credential, false);
        }
    }
    // A bare name after a credential key, in code or text of no known kind.
    if (any || kind === 'text') {
        for (const m of text.matchAll(BARE)) {
            const [s, e] = m.indices[2];
            const value = m[2];
            if (!CREDENTIAL.test(m[1]) || !secretShaped(value, false) || keyword(value, scan.language))
                continue;
            out.push({ start: s, end: e, value, credential: true, path: false, bare: true });
        }
    }
    // Pairs inside every value found so far.
    for (const span of out.slice()) {
        if (span.credential)
            continue;
        for (const m of span.value.matchAll(INNER)) {
            if (!CREDENTIAL.test(m[1]))
                continue;
            const [s, e] = m.indices[2];
            add(span.start + s, span.start + e, true, false);
        }
    }
    // A value written as one wins over the same text read as a bare name.
    return out.sort((a, b) => a.start - b.start || b.end - a.end || Number(!!a.bare) - Number(!!b.bare));
}
const BARE = /(?<![\w$.-])["'`]?([A-Za-z_$][\w$.-]{0,100})["'`]?\]?[ \t]*(?:=>|:=|=(?![=~>])|:(?!:))[ \t]*([A-Za-z_$][\w$]{0,255})(?=[ \t]*(?:[,;})\]#<]|\/\/|\r?$))/dgm;
/** The credential values among `spans`, never overlapping: the first wins. */
export function credentialsAmong(spans) {
    const out = [];
    for (const s of spans)
        if (s.credential && (!out.length || s.start >= out[out.length - 1].end))
            out.push(s);
    return out;
}
