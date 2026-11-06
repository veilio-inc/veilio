---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

`restore` strips a JSDoc block only where its `/**` opens in code, not inside a string, a template literal, a regex literal or another comment. `"src/**/*.ts"` no longer loses the rest of its line, `"a/**/b"` no longer takes every line up to the next `*/` with it, and a `/** */` inside a `//` comment stays in that comment (inside a `// TODO` it is stripped once, with the TODO). An empty `/**/` is a plain block comment. JSDoc inside a fenced markdown code block is still stripped.

What counts as code is a lexical reading, not a parse, so a few cases are guesses. Where a guess is wrong, the result is no worse than the old pattern, which stripped from any `/**` to the next `*/`: apart from one shape, `*/**`, where the new reading strips the real JSDoc that follows, it strips nothing the old pattern kept.

- a `/` is read as a regex literal or a division from the character before it. After `)`, `}` or `<` the guess can be wrong: `if (x) /[/**]/` and `a < /"/.test(s)` read the `/` as a division, so the regex's `/**` or quote counts as code. A misread can hide a JSDoc that should go, or shift where a string or comment starts and strip a `/**` that is not one;
- a markdown fence line (three or more backticks or tildes at the start of a line, indented or not) is read as a fence. It ends a backtick left open before it, so a `~~~` line inside a template literal ends that literal for this reading, and a JavaScript line starting with `~~~` is read as a fence;
- a backtick that never closes is read as prose, but two stray backticks in prose still pair up as a template literal, and a JSDoc between them is kept.
