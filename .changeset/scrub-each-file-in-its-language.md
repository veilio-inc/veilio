---
'@veilio-inc/cli': patch
---

`veilio scrub a.ts b.go …` now masks each file in its own language, taken from the file's extension, and builds the same map as scrubbing the files one at a time. One call over many files used to guess a single language for all of them, so a mixed repository could get one language's keywords masked as another's identifiers. The names a file imports from a public package (an unscoped npm package, a Python module that is not in the project, the Go standard library) are left as written, unless another input declares the same name. Needs the engine release that adds `externalNames` and `languageOfPath`.
