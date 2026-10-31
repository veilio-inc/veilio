// Spec 064: names the engine leaves as written because they are not anybody's
// secret - a single common English word, the vocabulary every codebase shares
// (src, util, com), and the toolchains a model is told to run. In spec 062's
// sessions 57% of placeholders hid such a word, 56% sat in file paths, and the
// model listed the whole tree to find files it could no longer read.
//
// A name with an inner capital, an underscore or a digit is never ordinary: it
// is a choice somebody made (ledgerEntry, berth_quorum, invoice2). Neither is a
// mixed-case word no dictionary spells (lEdger). Custom rules still win.
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
// Security audit (spec 064 regression): a dictionary-word password is an
// ordinary word, but as the value of a credential-named key it is a password.
// A key ends in a credential word at a word boundary (`DB_PASSWORD`, `apiKey`,
// `db.password`, `$password`), so `password_hint`, `author` and `monkey` are
// not credential-named.
const CREDENTIAL_KEY_END = /(?:api[_-]?key|pass(?:word|wd|phrase)?s?|pwd|pw|secrets?|tokens?|keys?|auth|credentials?)$/i;
// A `key` that names a record, an index or a lookup, not a credential.
const NOT_A_CREDENTIAL_KEY = /(?:primary|sort|foreign|partition|cache|index|unique|composite|routing|object|lookup|idempotency|row|column|group|hash|map|dict|translation|i18n|public|storage|search|shard|sharding)[_.-]?keys?$/i;
// A placeholder in the slot is text already masked, not a password.
const PLACEHOLDER = /^__[A-Z][A-Z0-9_]*__\d*$/;
const NOT_A_VALUE = /^(?:true|false|null|none|nil|undefined|yes|no|on|off)$/i;
// An unquoted `$NAME` is a reference to another variable
// (`DB_PASSWORD=$DB_PASSWORD`); a quoted one (`"$unshine"`) is a value.
const REFERENCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
// A value is one word: quoted whole, or bare where the line or the entry ends
// after it - so prose (`"sunshine is a word"`) is not one. Each alternative
// below captures the key, then the value in one of these groups.
const WORD = '[A-Za-z_$][\\w$]{0,255}';
const QUOTED = `"(${WORD})"|'(${WORD})'|\`(${WORD})\``;
const BARE_END = `(${WORD})(?=[ \\t]*(?:[,;})\\]#<]|\\/\\/|\\r?$))`;
const KEY = '[A-Za-z_$][\\w$.-]{0,100}';
// Each shape: a credential-named key, a separator or a call-argument boundary,
// then the value. Linear: a key starts only where a run of key characters
// starts, every run is bounded, and no quantified group nests another.
const SHAPES = [
    // `key = value`, `key: value`, `"key": "value"`, `key => value`, an env
    // line, a subscript (`env["KEY"] = v`, `config[:key] = v`).
    new RegExp(`(?<![\\w$.-])["'\`]?(${KEY})["'\`]?\\]?[ \\t]*(?:=>|:=|=(?![=~])|:(?!:))[ \\t]*(?:${QUOTED}|${BARE_END})`, 'dgm'),
    // A call's two string arguments: `define('KEY', 'v')`, `os.Setenv("KEY", "v")`.
    new RegExp(`(?<![\\w$])["'](${KEY})["'][ \\t]*,[ \\t]*(?:${QUOTED})[ \\t]*\\)`, 'dg'),
    // A Dockerfile's `ENV KEY value`.
    new RegExp(`^[ \\t]*ENV[ \\t]+(${KEY})[ \\t]+(?:${QUOTED}|(${WORD}))[ \\t]*\\r?$`, 'dgm'),
    // A k8s or compose env entry: `name: KEY` and, next in the same entry, `value: v`.
    new RegExp(`(?<![\\w$])["']?name["']?[ \\t]*:[ \\t]*["']?(${KEY})["']?[ \\t]*(?:,|\\r?\\n)[ \\t]*["']?value["']?[ \\t]*:[ \\t]*(?:${QUOTED}|${BARE_END})`, 'dgm'),
    // An XML element: `<key>v</`, or its `key="..."`/`name="..."` attribute.
    new RegExp(`<([A-Za-z_][\\w.:-]{0,100})((?:[ \\t]+[\\w.:-]{1,100}[ \\t]*=[ \\t]*"[^"<>]{0,200}"){0,20})[ \\t]*>[ \\t]*(${WORD})[ \\t]*<\\/`, 'dg'),
];
const XML_KEY_ATTR = /(?:^|[ \t])(?:key|name)[ \t]*=[ \t]*"([^"]*)"/g;
function credentialNamed(key) {
    const m = CREDENTIAL_KEY_END.exec(key);
    if (!m)
        return false;
    // `key` alone names a lookup (`<entry key="...">`, React's `key`), and a
    // record's `primary_key` is no credential either.
    if (/^keys?$/i.test(m[0]) && (m[0] === key || NOT_A_CREDENTIAL_KEY.test(key)))
        return false;
    if (m.index === 0)
        return true;
    // A long credential word needs no boundary: `PGPASSWORD`, `userpassword`.
    if (/^pass(?:word|wd|phrase)s?$/i.test(m[0]))
        return true;
    const before = key[m.index - 1];
    return /[._$:-]/.test(before) || (/[a-z0-9]/.test(before) && /[A-Z]/.test(key[m.index]));
}
/** The key a shape's match names: in XML, the element's `key` or `name`
 *  attribute where it has one, else its tag. */
function keyOf(m, shape) {
    if (shape !== SHAPES.length - 1)
        return m[1];
    let attr;
    for (const a of (m[2] ?? '').matchAll(XML_KEY_ATTR))
        attr = a[1];
    return attr ?? m[1];
}
/** Where `text` holds a word as the value of a credential-named key. Such a
 *  word is never left readable as an ordinary word: the engine masks it
 *  there, and the guard writes its map's entry over it. Sorted, and never
 *  overlapping. */
export function credentialValueSpans(text) {
    const found = [];
    SHAPES.forEach((re, shape) => {
        const first = shape === SHAPES.length - 1 ? 3 : 2;
        for (const m of text.matchAll(re)) {
            let g = first;
            while (g < m.length && m[g] === undefined)
                g++;
            const value = m[g];
            // The three QUOTED groups come first; XML text is a value as written.
            const quoted = shape === SHAPES.length - 1 || g < first + 3;
            if (!value || NOT_A_VALUE.test(value) || PLACEHOLDER.test(value))
                continue;
            if (!quoted && REFERENCE.test(value))
                continue;
            const key = keyOf(m, shape);
            // A value that is its own key is a label (`PASSWORD = "PASSWORD"`).
            if (value === key || !credentialNamed(key))
                continue;
            const [start, end] = m.indices[g];
            found.push({ start, end, value });
        }
    });
    found.sort((a, b) => a.start - b.start);
    const out = [];
    for (const s of found)
        if (!out.length || s.start >= out[out.length - 1].end)
            out.push(s);
    return out;
}
