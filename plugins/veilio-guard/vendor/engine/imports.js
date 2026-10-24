// What a file takes from outside the project, and what it declares itself.
//
// Spec 050 R4: a third-party package's name and the names imported from it are
// public - `vitest`, `describe`, `expect` - so masking them hides nothing
// of the user's and costs the model readability. A name the project declares is
// its own and is masked even when a package exports the same word. The guard and
// the CLI both use this, so it lives here; the tokenizer does not call it.
//
// Line-anchored patterns, not a parser. An import written inside a string
// literal at the start of a line (a code sample in a test fixture) is read as an
// import too, which can only leave more third-party names as written, never
// mask fewer of the project's: declarations win over imports.
import { isKeyword } from './languages.js';
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** `import express from 'express'`: the binding is named after the package. */
function namedAfter(local, specifier) {
    const last = specifier.split(/[/:]/).pop() ?? '';
    const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return squash(local) !== '' && squash(local) === squash(last);
}
/** `a, b as c, type d` (TS) or `a, b: c` (destructuring) -> the exported names. */
function namedList(list, alias) {
    return list
        .split(',')
        .map((part) => part.trim().replace(/^type\s+/, ''))
        .map((part) => part.split(alias)[0].trim())
        .filter((name) => IDENT.test(name));
}
function scriptImports(text) {
    const found = [];
    const add = (at, specifier, names) => found.push({ at, entry: { specifier, names } });
    // The clause holds no quote or semicolon: `import 'x'` must not run on into the
    // next statement's `from`.
    const fromClause = /^[ \t]*(import|export)\s+(?:type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(fromClause)) {
        const [, keyword, clause, specifier] = m;
        const names = [];
        const braces = clause.match(/\{([\s\S]*)\}/);
        if (braces)
            names.push(...namedList(braces[1], /\s+as\s+/));
        const outside = clause
            .replace(/\{[\s\S]*\}/, '')
            .replace(/,/g, ' ')
            .trim();
        const star = outside.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
        const binding = star ? star[1] : keyword === 'import' ? outside.split(/\s+/)[0] : '';
        if (binding && IDENT.test(binding) && namedAfter(binding, specifier))
            names.unshift(binding);
        add(m.index, specifier, names);
    }
    for (const m of text.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm))
        add(m.index, m[1], []);
    const required = /^[ \t]*(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const m of text.matchAll(required)) {
        const [, target, specifier] = m;
        const names = target.startsWith('{')
            ? namedList(target.slice(1, -1), /\s*:\s*/)
            : namedAfter(target, specifier)
                ? [target]
                : [];
        add(m.index, specifier, names);
    }
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
        add(m.index, m[1], []);
    return found.sort((a, b) => a.at - b.at).map((f) => f.entry);
}
function pythonImports(text) {
    const found = [];
    for (const m of text.matchAll(/^[ \t]*import\s+([^\n#]+)/gm)) {
        for (const part of m[1].split(',')) {
            const specifier = part
                .trim()
                .split(/\s+as\s+/)[0]
                .trim();
            if (specifier)
                found.push({ at: m.index, entry: { specifier, names: [] } });
        }
    }
    const from = /^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm;
    for (const m of text.matchAll(from)) {
        const list = m[2].replace(/^\(|\)$/g, '');
        found.push({
            at: m.index,
            entry: { specifier: m[1], names: namedList(list.replace(/\n/g, ' '), /\s+as\s+/) },
        });
    }
    return found.sort((a, b) => a.at - b.at).map((f) => f.entry);
}
function goImports(text) {
    const specs = [];
    const one = /^[ \t]*import\s+(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"/gm;
    for (const m of text.matchAll(one))
        specs.push({ alias: m[1] ?? null, specifier: m[2] });
    for (const block of text.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)/gm)) {
        for (const m of block[1].matchAll(/^[ \t]*(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"/gm))
            specs.push({ alias: m[1] ?? null, specifier: m[2] });
    }
    return specs.map(({ alias, specifier }) => {
        const last = specifier.split('/').pop() ?? '';
        const local = alias ?? last;
        // Go reaches into a package by `pkg.Name`; those names are the package's.
        const selectors = [...text.matchAll(new RegExp(`\\b${local}\\.([A-Za-z_]\\w*)`, 'g'))].map((m) => m[1]);
        const names = [...(alias ? [] : [last]), ...new Set(selectors)];
        return { specifier, names };
    });
}
/** The import statements of `text`, in order. Languages other than
 *  TypeScript/JavaScript, Python and Go return none. */
export function parseImports(text, language) {
    if (language === 'typescript')
        return scriptImports(text);
    if (language === 'python')
        return pythonImports(text);
    if (language === 'go')
        return goImports(text);
    return [];
}
function scriptDeclarations(text) {
    const out = [];
    const patterns = [
        /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
        /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
        /^[ \t]*(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
        /^[ \t]*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/gm,
        // Class members: `settle(batch: Batch): void {`, with modifiers.
        /^[ \t]+(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{;]+)?\{/gm,
    ];
    for (const re of patterns)
        for (const m of text.matchAll(re))
            out.push(m[1]);
    const variables = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^\n]*)/gm;
    for (const m of text.matchAll(variables)) {
        if (/^require\(/.test(m[2].trim()))
            continue;
        if (m[1].startsWith('{'))
            out.push(...namedList(m[1].slice(1, -1), /\s*:\s*/));
        else
            out.push(m[1]);
    }
    return out;
}
function pythonDeclarations(text) {
    const out = [];
    for (const m of text.matchAll(/^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm))
        out.push(m[1]);
    for (const m of text.matchAll(/^[ \t]*class\s+([A-Za-z_]\w*)/gm))
        out.push(m[1]);
    for (const m of text.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm))
        out.push(m[1]);
    return out;
}
function goDeclarations(text) {
    const out = [];
    for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm))
        out.push(m[1]);
    for (const m of text.matchAll(/^(?:type|var|const)\s+([A-Za-z_]\w*)/gm))
        out.push(m[1]);
    for (const block of text.matchAll(/^(?:type|var|const)\s*\(([\s\S]*?)^\)/gm))
        for (const m of block[1].matchAll(/^[ \t]*([A-Za-z_]\w*)\b/gm))
            out.push(m[1]);
    return out;
}
/** The names `text` declares: functions, classes, types, module variables and,
 *  for TypeScript, class members. Keywords are left out. */
export function parseDeclarations(text, language) {
    const raw = language === 'typescript'
        ? scriptDeclarations(text)
        : language === 'python'
            ? pythonDeclarations(text)
            : language === 'go'
                ? goDeclarations(text)
                : [];
    return [...new Set(raw)].filter((name) => !isKeyword(name, language));
}
/** True when `specifier` names something outside the project. Unsupported
 *  languages answer false: nothing of theirs is exempted. */
export function isExternalSpecifier(specifier, language, project) {
    if (language === 'typescript') {
        if (specifier.startsWith('.') || specifier.startsWith('/'))
            return false;
        if ((project.workspaces ?? []).some((w) => specifier === w || specifier.startsWith(`${w}/`)))
            return false;
        return !(project.pathAliases ?? []).some((a) => specifier.startsWith(a));
    }
    if (language === 'python') {
        if (specifier.startsWith('.'))
            return false;
        return !(project.pythonModules ?? []).includes(specifier.split('.')[0]);
    }
    if (language === 'go') {
        const mod = project.goModule;
        return !(mod && (specifier === mod || specifier.startsWith(`${mod}/`)));
    }
    return false;
}
/** Everything in `text` that comes from outside the project: each external
 *  specifier, its path segments, and the names imported from it - less any name
 *  the same text declares. */
export function externalNames(text, language, project) {
    const declared = new Set(parseDeclarations(text, language));
    const out = new Set();
    for (const { specifier, names } of parseImports(text, language)) {
        if (!isExternalSpecifier(specifier, language, project))
            continue;
        out.add(specifier);
        for (const segment of specifier.split(/[/:.@]/))
            if (IDENT.test(segment))
                out.add(segment);
        for (const name of names)
            out.add(name);
    }
    for (const name of declared)
        out.delete(name);
    return out;
}
