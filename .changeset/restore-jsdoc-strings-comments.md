---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

`restore` strips a JSDoc block only where its `/**` opens in code, not inside a string, a template literal, a regex literal or another comment. `"src/**/*.ts"` no longer loses the rest of its line, `"a/**/b"` no longer takes every line up to the next `*/` with it, and a `/** */` inside a `//` comment stays in that comment (inside a `// TODO` it is stripped once, with the TODO). An empty `/**/` is a plain block comment. JSDoc inside a fenced markdown code block is still stripped.

What counts as code is a lexical reading, not a parse, so a few cases are guesses:

- a `/` is read as a regex literal or a division from the character before it: after `)` or `}` the guess can be wrong. A regex such as `if (x) /[/**]/` is read as a division, and its `/**` as a JSDoc running to the next `*/`, which is stripped as before this change. A division read as a regex only keeps a JSDoc that should have gone;
- a markdown fence line (three backticks or tildes at the start of a line) in code is read as a fence;
- a backtick that never closes is read as prose, but two stray backticks in prose still pair up as a template literal, and a JSDoc between them is kept.
