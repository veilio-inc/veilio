import { describe, it, expect } from 'vitest'
import { anonymize, measureCommentExposure } from '../src/engine.js'
import type { Language } from '../src/languages.js'

// 004-b3. The engine masks identifiers and leaves comment prose alone, and that
// trade is right — masked prose reads as ciphertext and trips downstream-AI
// refusals. What was wrong was that the trade was invisible: the output looked
// handled, and the sentence naming a customer went out with it.
//
// So the result now carries the measurement. These tests are about the number
// being one a reader would recognise and act on, because a count that
// overstates is a count people learn to skip — the same failure 001-b1 removed
// from the credential panel.
//
// What is deliberately NOT tested anywhere here: that the engine can tell a
// sensitive comment from a harmless one. It cannot, permanently, and any test
// asserting it could would be describing a feature this spec forecloses.

// ─── Per-language comment syntax (FR-005: uses the existing handling) ────────

interface Sample {
  language: Language
  code: string
  line: string
  /** A block or docstring form, where the language has one. */
  block?: string
  /** Comment characters that are only characters here, inside a string. */
  stringWithMarker: string
}

const SAMPLES: Sample[] = [
  {
    language: 'typescript',
    code: 'const orderTotal = settleInvoice(cart)',
    line: '// Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: 'const banner = "// Contoso Health"',
  },
  {
    language: 'go',
    code: 'orderTotal := settleInvoice(cart)',
    line: '// Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: 'banner := "// Contoso Health"',
  },
  {
    language: 'java',
    code: 'int orderTotal = settleInvoice(cart);',
    line: '// Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: 'String banner = "// Contoso Health";',
  },
  {
    language: 'csharp',
    code: 'var orderTotal = SettleInvoice(cart);',
    line: '// Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: 'var banner = "// Contoso Health";',
  },
  {
    language: 'rust',
    code: 'let order_total = settle_invoice(cart);',
    line: '// Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: 'let banner = "// Contoso Health";',
  },
  {
    language: 'c',
    code: 'int order_total = settle_invoice(cart);',
    line: '// Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: 'char *banner = "// Contoso Health";',
  },
  {
    language: 'python',
    code: 'order_total = settle_invoice(cart)',
    line: '# Contoso Health outage, INC-4471',
    block: '"""Contoso Health outage, INC-4471"""',
    stringWithMarker: 'banner = "# Contoso Health"',
  },
  {
    language: 'ruby',
    code: 'order_total = settle_invoice(cart)',
    line: '# Contoso Health outage, INC-4471',
    block: '=begin\nContoso Health outage, INC-4471\n=end',
    stringWithMarker: 'banner = "# Contoso Health"',
  },
  {
    language: 'php',
    code: '$orderTotal = settleInvoice($cart);',
    line: '# Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: '$banner = "// Contoso Health";',
  },
  {
    language: 'sql',
    code: 'SELECT settled FROM invoice_ledger;',
    line: '-- Contoso Health outage, INC-4471',
    block: '/* Contoso Health outage, INC-4471 */',
    stringWithMarker: "SELECT '-- Contoso Health' AS banner;",
  },
]

describe('comment exposure — every supported language', () => {
  // Ten languages, not one: assuming `//` everywhere is the exact bug the
  // per-language syntax table exists to prevent, and a count that only knows
  // C-style comments would report zero for a Python file full of them — the
  // most dangerous possible answer, since it reads as "nothing to see".
  it.each(SAMPLES)('counts a line comment in $language', ({ language, code, line }) => {
    const { comments } = anonymize(`${code}\n${line}`, { language })
    expect(comments.total).toBe(1)
    expect(comments.inline).toBe(1)
    expect(comments.characters).toBeGreaterThan(0)
  })

  it.each(SAMPLES)('counts a block comment in $language', ({ language, code, block }) => {
    const { comments } = anonymize(`${code}\n${block}`, { language })
    expect(comments.total).toBe(1)
  })

  it.each(SAMPLES)(
    'does not count comment characters inside a string in $language',
    ({ language, stringWithMarker }) => {
      // FR-005: `blankComments` already distinguishes these and the suite covers
      // it. The count rides the same scanner, so this can only regress if
      // somebody gives it a second one.
      const { comments } = anonymize(stringWithMarker, { language })
      expect(comments.total).toBe(0)
      expect(comments.characters).toBe(0)
    }
  )
})

// ─── FR-003 / SC-002: silence when there is nothing to say ──────────────────

describe('comment exposure — when nothing leaves', () => {
  it('reports no comments for code that has none', () => {
    const { comments } = anonymize('const orderTotal = settleInvoice(cart)')
    expect(comments).toEqual({ total: 0, inline: 0, characters: 0, severity: 'low' })
  })

  it('reports no comments for empty input', () => {
    expect(anonymize('').comments.total).toBe(0)
  })

  it('does not count a rule of dashes as prose', () => {
    // A separator leaks nothing. Counting it is how "3 comments" starts meaning
    // "some punctuation", and the number stops being worth reading.
    const { comments } = anonymize('// ----------------\nconst orderTotal = 1')
    expect(comments.total).toBe(0)
    expect(comments.characters).toBe(0)
  })

  it('does not count a row of box characters as prose', () => {
    expect(anonymize('// ──────────\nconst orderTotal = 1').comments.total).toBe(0)
  })

  it('does not count an empty comment', () => {
    expect(anonymize('const orderTotal = 1 //').comments.total).toBe(0)
  })

  it('counts a comment that is only digits', () => {
    // `\p{N}`, not just letters: `// 4471` is an incident number, which is
    // precisely the kind of thing this spec exists to surface.
    expect(anonymize('const orderTotal = 1 // 4471').comments.total).toBe(1)
  })
})

// ─── Counting the way a reader counts ───────────────────────────────────────

describe('comment exposure — one block, not one per line', () => {
  const LICENCE = [
    '// Copyright 2026 Veilio',
    '// Licensed under the Veilio Community Licence 1.0.',
    '// See LICENSE at the repository root.',
    '// SPDX-License-Identifier: LicenseRef-Veilio-Community-1.0',
    '// This file is provided without warranty.',
  ].join('\n')

  it('counts a five-line header as one comment', () => {
    // The gap between two consecutive line comments is a bare newline. Reading
    // that as code reports this header as five separate comments, and every
    // file in the repository then looks like a five-comment leak.
    const { comments } = anonymize(`${LICENCE}\nconst orderTotal = settleInvoice(cart)`)
    expect(comments.total).toBe(1)
  })

  it('keeps a header with a blank comment line in it as one comment', () => {
    const source = `// Copyright 2026 Veilio\n//\n// See LICENSE.\nconst orderTotal = 1`
    expect(anonymize(source).comments.total).toBe(1)
  })

  it('splits comments separated by a blank line', () => {
    // A blank line is how a writer separates two notes about two things.
    // Merging across it announces three separate leaks as one, which is
    // under-reporting in the direction that reassures — the worst direction for
    // a feature whose entire value is a count somebody believes.
    const source = [
      '// note about the Contoso account',
      '',
      '// note about Maria',
      '',
      '// note about INC-4471',
      'const orderTotal = 1',
    ].join('\n')
    expect(anonymize(source).comments.total).toBe(3)
  })

  it('does not split a header on a bare comment marker', () => {
    // `//` on its own is a blank line INSIDE a comment block, not between two.
    // Licence headers are written this way constantly.
    const source = `// Copyright 2026 Veilio\n//\n// See LICENSE.\nconst orderTotal = 1`
    expect(anonymize(source).comments.total).toBe(1)
  })

  it('does not let a shebang demote the licence header beneath it', () => {
    // `#!` is not a comment opener in TypeScript, so it reads as the file's
    // first code and pushes the header into "inside the body" — on exactly the
    // files that carry a shebang, which are CLI entry points.
    const withShebang = '#!/usr/bin/env node\n// Copyright 2026 Veilio\nconst orderTotal = 1'
    const without = '// Copyright 2026 Veilio\nconst orderTotal = 1'
    expect(anonymize(withShebang).comments).toEqual(anonymize(without).comments)
    expect(anonymize(withShebang).comments.severity).toBe('low')
  })

  it('agrees with itself across comment styles', () => {
    // A five-line `//` header and the equivalent block comment are the same
    // thing to a reader. If the two disagree, the number is about syntax rather
    // than about exposure.
    const asLines = anonymize(`${LICENCE}\nconst orderTotal = 1`).comments
    const asBlock = anonymize(
      `/*\n * Copyright 2026 Veilio\n * Licensed under the Veilio Community Licence 1.0.\n */\nconst orderTotal = 1`
    ).comments
    expect(asLines.total).toBe(asBlock.total)
    expect(asLines.severity).toBe(asBlock.severity)
  })

  it('charges the same for identical prose in either comment style', () => {
    // Counting a block segment whole includes its newlines and ` * ` gutter,
    // which the equivalent `//` lines never had — the same sentence then reads
    // ~30% larger as a block, and the number is about syntax, not exposure.
    const asLines = anonymize('const a = 1\n// Settles an invoice.\n// Contoso Health only.')
    const asBlock = anonymize(
      'const a = 1\n/*\n * Settles an invoice.\n * Contoso Health only.\n */'
    )
    expect(asLines.comments.characters).toBeGreaterThan(0)
    expect(Math.abs(asLines.comments.characters - asBlock.comments.characters)).toBeLessThanOrEqual(
      '/**/'.length
    )
  })

  it('counts an uppercase macro in a comment as the prose it is', () => {
    // `__GNUC__` is somebody's code and it leaves unmasked. Only tokens this
    // engine minted are exempt, and every one of those carries a counter or the
    // redaction prefix.
    const withMacro = anonymize('int a = 1; /* only on __GNUC__ builds */', { language: 'c' })
    const withWord = anonymize('int a = 1; /* only on ORDINARY builds */', { language: 'c' })
    expect(withMacro.comments.characters).toBe(withWord.comments.characters)
  })

  it('splits blocks that have code between them', () => {
    const source = ['// first note', 'const a = one()', '// second note', 'const b = two()'].join(
      '\n'
    )
    expect(anonymize(source).comments.total).toBe(2)
  })
})

// ─── FR-007: grading, on 001-b1's scale ─────────────────────────────────────

describe('comment exposure — grading', () => {
  it('grades a licence header quietly', () => {
    // Edge case from the spec. A header sits in nearly every file and is almost
    // never sensitive; grading it the same as a note written beside a function
    // is how this becomes the next thing users learn to ignore.
    const source = '// Copyright 2026 Veilio\n// See LICENSE.\nconst orderTotal = settleInvoice(c)'
    const { comments } = anonymize(source)
    expect(comments.total).toBe(1)
    expect(comments.inline).toBe(0)
    expect(comments.severity).toBe('low')
  })

  it('grades a comment-only file quietly', () => {
    // Also from the spec: the warning must be proportionate. A file with no code
    // has nothing interleaved with it by definition.
    const source = '// notes from the Contoso outage\n// nothing else in here'
    const { comments } = anonymize(source)
    expect(comments.total).toBe(1)
    expect(comments.inline).toBe(0)
    expect(comments.severity).toBe('low')
  })

  it('grades a comment written beside code as advisory', () => {
    const { comments } = anonymize('const orderTotal = 1 // ping Maria before touching this')
    expect(comments.inline).toBe(1)
    expect(comments.severity).toBe('medium')
  })

  it('separates the header from the notes inside the body', () => {
    const source = [
      '// Copyright 2026 Veilio',
      'const orderTotal = settleInvoice(cart)',
      '// Contoso Health outage, INC-4471',
      'const retries = 3',
    ].join('\n')
    const { comments } = anonymize(source)
    expect(comments.total).toBe(2)
    expect(comments.inline).toBe(1)
    expect(comments.severity).toBe('medium')
  })

  it('never grades comment prose above advisory, however much of it there is', () => {
    // The cap is the point. The engine has no evidence that any of this is
    // sensitive — it cannot read it — and dressing an unread comment as a
    // credential is the crying wolf 001-b1 took out of the panel next to it.
    const source = Array.from(
      { length: 200 },
      (_, i) => `const v${i} = compute() // note ${i} about the Contoso account`
    ).join('\n')
    const { comments } = anonymize(source)
    expect(comments.total).toBe(200)
    expect(comments.severity).toBe('medium')
  })
})

// ─── The character count means what it says ─────────────────────────────────

describe('comment exposure — how much prose', () => {
  it('grows with the prose', () => {
    const short = anonymize('const a = 1 // note').comments.characters
    const long = anonymize(
      'const a = 1 // a considerably longer note about the Contoso Health outage'
    ).comments.characters
    expect(long).toBeGreaterThan(short)
  })

  it('does not charge for a placeholder already standing in for a marked term', () => {
    // US1 and US2 have to agree. Marking a name in a comment is the gesture this
    // warning asks for; if the warning does not move afterwards, the gesture
    // looks like it did nothing.
    const source = 'const orderTotal = 1 // ping Maria Sanchez before touching this'
    const before = anonymize(source).comments.characters
    const after = anonymize(source, { manual: ['Maria Sanchez'] }).comments.characters
    expect(before - after).toBe('Maria Sanchez'.length)
  })

  it('drops a comment left holding nothing but placeholders', () => {
    // Fully masked is not partly masked. Nothing in this comment leaks any more,
    // so there is nothing to warn about.
    const { comments } = anonymize('const orderTotal = 1 // Contoso', { manual: ['Contoso'] })
    expect(comments.total).toBe(0)
    expect(comments.characters).toBe(0)
  })

  it('does not charge for a credential the scanner already redacted', () => {
    const source = 'const c = 1 // key was AKIAIOSFODNN7EXAMPLE'
    const { anonymized, comments } = anonymize(source)
    expect(anonymized).toContain('__REDACTED_')
    expect(comments.characters).toBe('// key was '.trim().length)
  })
})

// ─── The standalone entry point ─────────────────────────────────────────────

describe('measureCommentExposure', () => {
  it('agrees with what anonymize reports for the same text', () => {
    const source = '// Copyright 2026\nconst orderTotal = 1 // note about Contoso'
    expect(measureCommentExposure(source)).toEqual(anonymize(source).comments)
  })

  it('honours an explicit language', () => {
    // `# note` is a comment in Python and a stray token in TypeScript. Reading
    // it as code is the failure the per-language table exists to prevent.
    const source = 'order_total = 1 # note about the Contoso account'
    expect(measureCommentExposure(source, 'python').total).toBe(1)
  })

  it('detects the language when not told', () => {
    expect(measureCommentExposure('const orderTotal = 1 // a note').total).toBe(1)
  })
})
