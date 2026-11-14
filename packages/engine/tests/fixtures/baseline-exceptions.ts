// The rows of baseline-corpus.ts whose answer may differ from the published
// 1.19.1 (baseline-1.19.1.json), one entry per row and option set, each with
// the fix that changes it. Written row by row, never as a pattern: a
// difference nobody listed must fail the test.
import type { AnonymizeOptions } from '../../src/types.js'

export const FINDINGS = ['C1', 'C2', 'M3', 'H1', 'M4', 'L4'] as const

export interface BaselineException {
  row: string
  options: AnonymizeOptions
  finding: (typeof FINDINGS)[number]
  why: string
}

export const EXCEPTIONS: BaselineException[] = [
  {
    row: 'url: api_key as the first parameter',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: api_key as the first parameter',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: api_key in the fragment',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: api_key in the fragment',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: access_token as the first parameter',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: access_token as the first parameter',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: access_token in the fragment',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: access_token in the fragment',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: token as the first parameter',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: token as the first parameter',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: token in the fragment',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: token in the fragment',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: secret as the first parameter',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: secret as the first parameter',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: secret in the fragment',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: secret in the fragment',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: password as the first parameter',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: password as the first parameter',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: password in the fragment',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: password in the fragment',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: key as the first parameter',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: key as the first parameter',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: key in the fragment',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: key in the fragment',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: api_key first, in a template literal',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: api_key first, in a template literal',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: key first, in Python',
    options: { language: 'python' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: access_token in the fragment, in Python',
    options: { language: 'python' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: a credential after a nested question mark',
    options: { language: 'typescript' },
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'url: a credential after a nested question mark',
    options: {},
    finding: 'H1',
    why: 'a credential in the first query parameter or the fragment of a URL is redacted',
  },
  {
    row: 'key: BEGIN, two body lines, no END',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: BEGIN, two body lines, no END',
    options: { fileKind: 'text' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: a body of 12,000 characters with END',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: a body of 12,000 characters with END',
    options: { fileKind: 'text' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: a body of 12,000 characters, no END',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: a body of 12,000 characters, no END',
    options: { fileKind: 'text' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: a short line after the body, no END',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: a short line after the body, no END',
    options: { fileKind: 'text' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: PEM headers, no END',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'key: PEM headers, no END',
    options: { fileKind: 'text' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: data',
    options: { fileKind: 'yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: data',
    options: { path: 'secret.yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: data',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: stringData with a block scalar',
    options: { fileKind: 'yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: stringData with a block scalar',
    options: { path: 'secret.yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: stringData with a block scalar',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: one of three documents',
    options: { fileKind: 'yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: one of three documents',
    options: { path: 'secret.yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: one of three documents',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: inside a List',
    options: { fileKind: 'yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: inside a List',
    options: { path: 'secret.yaml' },
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'secret manifest: inside a List',
    options: {},
    finding: 'M4',
    why: 'key material after a BEGIN line and the values of a Secret manifest are redacted',
  },
  {
    row: 'joined key: three literals',
    options: { language: 'typescript' },
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: three literals',
    options: {},
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: two literals',
    options: { language: 'typescript' },
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: two literals',
    options: {},
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: eight literals',
    options: { language: 'typescript' },
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: eight literals',
    options: {},
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: adjacent literals in Python',
    options: { language: 'python' },
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: adjacent literals in C',
    options: { language: 'c' },
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
  {
    row: 'joined key: adjacent literals in C',
    options: {},
    finding: 'L4',
    why: 'a provider key written as adjacent string literals is redacted',
  },
]
