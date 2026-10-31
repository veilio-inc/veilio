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
// `db.password`), so `password_hint` and `monkey` are not credential-named.
const CREDENTIAL_KEY_END = /(?:api[_-]?key|pass(?:word|wd|phrase)?|pwd|secret|token|key|auth|credentials?)$/i;
// A placeholder in the slot is text already masked, not a password.
const PLACEHOLDER = /^__[A-Z][A-Z0-9_]*__\d*$/;
const NOT_A_VALUE = /^(?:true|false|null|none|nil|undefined|yes|no|on|off)$/i;
// `key = value`, `key: value`, `"key": "value"`, `key => value`, an env line:
// the value is the whole value - one quoted word, or one bare word the line
// or the entry ends after - so prose (`"sunshine is a word"`) is not one.
// Linear: a key starts only where a run of key characters starts, and is short.
const KEY_VALUE = /(?<![\w$.-])["'`]?([A-Za-z_$][\w$.-]{0,100})["'`]?[ \t]*(?:=>|:=|=(?![=~])|:(?!:))[ \t]*(?:"([A-Za-z_$][\w$]{0,255})"|'([A-Za-z_$][\w$]{0,255})'|([A-Za-z_$][\w$]{0,255})(?=[ \t]*(?:[,;})\]#]|\/\/|\r?$)))/dgm;
function credentialNamed(key) {
    const m = CREDENTIAL_KEY_END.exec(key);
    if (!m)
        return false;
    if (m.index === 0)
        return true;
    const before = key[m.index - 1];
    return /[._-]/.test(before) || (/[a-z0-9]/.test(before) && /[A-Z]/.test(key[m.index]));
}
/** Where `text` holds a word as the value of a credential-named key. Such a
 *  word is never left readable as an ordinary word: the engine masks it
 *  there, and the guard writes its map's entry over it. */
export function credentialValueSpans(text) {
    const out = [];
    for (const m of text.matchAll(KEY_VALUE)) {
        const g = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : 4;
        const value = m[g];
        if (!value || !credentialNamed(m[1]) || NOT_A_VALUE.test(value) || PLACEHOLDER.test(value))
            continue;
        const [start, end] = m.indices[g];
        out.push({ start, end, value });
    }
    return out;
}
