import { describe, it, expect } from 'vitest'
import { anonymize, restore, extractIdentifiers } from '../src/engine.js'

// Comments are natural-language prose; masking their words turns the output into
// what reads as ciphertext (`// → __P5__ __P6__ it …`) and trips downstream-AI
// refusals. Identifiers inside STRING literals are still masked on purpose (see
// engine.edge.test.ts) — that privacy behavior must be preserved.

describe('anonymize leaves comments unmasked', () => {
  it('does not mask words inside a line comment', () => {
    const { anonymized, map } = anonymize(
      'const userToken = grabToken() // resolve the credential later'
    )
    expect(anonymized).toContain('// resolve the credential later')
    // a word that lives ONLY in the comment never enters the map
    expect(Object.values(map)).not.toContain('credential')
  })

  it('does not mask words inside a block comment', () => {
    const { anonymized } = anonymize('/* returns the orderRecord */\nconst valueHolder = compute()')
    expect(anonymized).toContain('/* returns the orderRecord */')
  })

  it('still masks the code around a comment', () => {
    const { anonymized } = anonymize('const secretHandle = 1 // a note')
    expect(anonymized).not.toContain('secretHandle')
    expect(anonymized).toContain('// a note')
  })

  it('round-trips code that contains a comment', () => {
    const original = [
      'function shipOrder(orderId) {',
      '  // look up the order before shipping',
      '  return database.dispatchOrder(orderId)',
      '}',
    ].join('\n')
    const { anonymized, map } = anonymize(original)
    expect(anonymized).toContain('// look up the order before shipping')
    expect(anonymized).not.toContain('shipOrder')
    const { restored } = restore(anonymized, map)
    expect(restored).toBe(original)
  })

  it('treats a quote inside a comment as plain text (scanner recovers)', () => {
    const { anonymized } = anonymize("// the user's payload\nconst greetingBanner = 2")
    expect(anonymized).toContain("// the user's payload")
    expect(anonymized).not.toContain('greetingBanner')
  })
})

describe('anonymize still masks strings (intentional privacy behavior preserved)', () => {
  it('masks an identifier inside a double-quoted string', () => {
    const { anonymized } = anonymize('const logLine = "PaymentService failed"')
    expect(anonymized).not.toContain('PaymentService')
  })

  it('does not treat // inside a string as a comment', () => {
    // If `//` started a comment, PaymentService would be "in a comment" and
    // survive. It must still be masked because it's inside a string literal.
    const { anonymized } = anonymize('const endpoint = "x//PaymentService"')
    expect(anonymized).not.toContain('PaymentService')
  })
})

describe('extractIdentifiers', () => {
  it('excludes words inside comments but keeps words inside strings', () => {
    const ids = extractIdentifiers('const realVariable = "stringName" // commentName')
    expect(ids).toContain('realVariable')
    expect(ids).toContain('stringName')
    expect(ids).not.toContain('commentName')
  })
})

// Spec 085 L7 (security audit run-1): in masking, a regex literal holding `//`
// or `/*`, a PHP 8 attribute and a Ruby `=begin` after other text were read
// as the start of a comment, so the code after them went to the model as
// written. Each fixture with its language and with none.
describe('code that only looks like a comment opener is masked as code (L7)', () => {
  const NAMES = /PaymentGateway|chargeCustomer|Fake-Value-123/
  const cases: [string, string, 'typescript' | 'php' | 'ruby'][] = [
    [
      'a regex literal ending in `\\//`',
      "const host = url.replace(/^https?:\\/\\//, ''); notify(PaymentGateway)\nexport class PaymentGateway {}",
      'typescript',
    ],
    [
      'a regex literal holding `\\/*`',
      "const trim = (p: string) => p.replace(/\\/*$/, '')\nexport class PaymentGateway { chargeCustomer() {} }",
      'typescript',
    ],
    [
      'a credential after the `\\/*` regex',
      "const trim = (p: string) => p.replace(/\\/*$/, '')\nconst apiSecretValue = 'Fake-Value-123'\nexport class PaymentGateway {}",
      'typescript',
    ],
    [
      'a division before a `\\/*` regex on the same line',
      "const half = size / 2; const trim = p.replace(/\\/*$/, '')\nexport class PaymentGateway {}",
      'typescript',
    ],
    [
      'a PHP 8 attribute',
      '<?php\n#[ORM\\Entity(repositoryClass: PaymentGatewayRepository::class)]\nclass PaymentGateway {}',
      'php',
    ],
    [
      'a Ruby `=begin` after other text',
      'state=begin_transfer(PaymentGateway)\nclass PaymentGateway; end',
      'ruby',
    ],
  ]
  for (const [what, code, language] of cases) {
    it(`${what}, as ${language}`, () => {
      expect(anonymize(code, { language }).anonymized).not.toMatch(NAMES)
    })
    it(`${what}, with no language given`, () => {
      expect(anonymize(code).anonymized).not.toMatch(NAMES)
    })
  }

  it('real comments are left as they were', () => {
    const ts = anonymize(
      'const ratio = totalAmount / itemCount // keep the PaymentGateway note\n' +
        '// see https://example.invalid/x for PaymentGateway\n' +
        '/* block about PaymentGateway */\nconst y = 1',
      { language: 'typescript' }
    ).anonymized
    expect(ts).toContain('// keep the PaymentGateway note')
    expect(ts).toContain('// see https://example.invalid/x for PaymentGateway')
    expect(ts).toContain('/* block about PaymentGateway */')
    const rb = anonymize('=begin\nNotes on PaymentGateway.\n=end\nvalue = 1', { language: 'ruby' })
    expect(rb.anonymized).toContain('Notes on PaymentGateway.')
    const php = anonymize('<?php\n# a note on PaymentGateway\n$value = 1;', { language: 'php' })
    expect(php.anonymized).toContain('# a note on PaymentGateway')
  })

  // FR-008 / SC-005: a regex literal with no comment opener reads exactly as
  // on the base engine (ba947f3), quirks included: its quote opens a string.
  it('a regex literal holding only a quote reads as it always did', () => {
    const code =
      "const quoteMark = /'/g; const total = 1 // PaymentGateway note\nexport class PaymentGateway {}"
    expect(anonymize(code, { language: 'typescript' }).anonymized).toBe(
      "const __VAR__1 = /'/g; const __STR__1 = 1 // __CLS__1 __STR__2\nexport class __CLS__1 {}"
    )
  })

  it('a Ruby block opened at a line start closes only at a line-start =end', () => {
    const rb = anonymize(
      '=begin\nstate=end_transfer is prose on PaymentGateway\n=end\nclass PaymentGateway; end',
      {
        language: 'ruby',
      }
    ).anonymized
    expect(rb).toContain('state=end_transfer is prose on PaymentGateway')
    expect(rb).not.toMatch(/class PaymentGateway/)
  })
})

// Spec 085 part 3, R2-11 (security audit run-2): the L7 regex rule read `)`
// before `/` as a division, and Ruby and PHP literals the tokenizer did not
// model (regex, heredoc, %-literal, interpolation) let a `#`, `//` or `/*`
// inside them open a comment, so the code after it went out unmasked.
describe('code inside a literal is not read as a comment (R2-11)', () => {
  const masked = (code: string, language?: 'typescript' | 'ruby' | 'php') =>
    anonymize(code, language ? { language } : {}).anonymized
  const after = (text: string, line: number) => text.split('\n').slice(line).join('\n')

  for (const language of ['typescript', undefined] as const)
    it(`a regex after \`)\` holding \`/*\` is code (${language ?? 'detected'})`, () => {
      const out = masked(
        'class PaymentGateway {}\nif (ok(p)) /\\/*$/.test(p)\nconst secretTotal = PaymentGateway.charge()\n',
        language
      )
      expect(out).not.toContain('PaymentGateway')
      expect(out).not.toContain('secretTotal')
    })

  it('Ruby: interpolation in a heredoc and in a regex is code', () => {
    const out = masked(
      'class PaymentGateway; end\nsql = <<~SQL\n  WHERE id = #{PaymentGateway.account_id}\nSQL\nx =~ /\\A#{PaymentGateway::PREFIX}/\n',
      'ruby'
    )
    expect(after(out, 1)).not.toContain('PaymentGateway')
  })

  it('Ruby: a `#` inside a heredoc, a %-literal or a regex opens no comment', () => {
    const out = masked(
      'class PaymentGateway; end\ntext = <<-EOS\n  # PaymentGateway.charge\nEOS\nlist = %w(a #PaymentGateway)\nre = %r{#PaymentGateway}\nm = x =~ /a#PaymentGateway/\n',
      'ruby'
    )
    expect(after(out, 1)).not.toContain('PaymentGateway')
  })

  it('PHP: a `#` inside a heredoc or a nowdoc opens no comment', () => {
    const out = masked(
      "<?php\nclass PaymentGateway {}\n$q = <<<EOT\n# PaymentGateway::find($id)\nEOT;\n$r = <<<'EOT'\n# PaymentGateway::raw\nEOT;\n",
      'php'
    )
    expect(after(out, 2)).not.toContain('PaymentGateway')
  })

  it('unchanged: real comments, a division, Ruby and PHP comments', () => {
    const cases: [string, string | undefined, string][] = [
      ['const r = a / b // note PaymentNote\n', 'typescript', '// note PaymentNote'],
      ['const r = f(x) / 2 // note PaymentNote\n', 'typescript', '// note PaymentNote'],
      ['x = 1 # note PaymentNote\n', 'ruby', '# note PaymentNote'],
      ['<?php\n$x = 1; # note PaymentNote\n', 'php', '# note PaymentNote'],
      ['<?php\n$x = 1 << 2; // note PaymentNote\n', 'php', '// note PaymentNote'],
      ['x = y << 2 # note PaymentNote\n', 'ruby', '# note PaymentNote'],
    ]
    for (const [code, language, kept] of cases)
      expect(masked(code, language as 'typescript'), code).toContain(kept)
  })
})

describe('heredoc and %-literal reading stays linear (R2-11)', () => {
  it('many openers with no terminator or close do not make masking quadratic', () => {
    const time = (n: number, line: (k: number) => string, language: 'ruby' | 'php') => {
      const code = Array.from({ length: n }, (_, k) => line(k)).join('\n')
      const t = performance.now()
      anonymize(code, { language })
      return performance.now() - t
    }
    for (const [line, language] of [
      [(k: number) => `x${k} = <<~ID${k % 50}`, 'ruby'],
      [(k: number) => `x${k} = %w(open${k}`, 'ruby'],
      [(k: number) => `$x${k} = <<<ID${k % 50}`, 'php'],
    ] as const) {
      const small = time(2000, line, language)
      const large = time(8000, line, language)
      expect(large / Math.max(small, 25)).toBeLessThan(10)
    }
  })
})

describe('the regex retry after `)` stays linear (R2-11)', () => {
  it('many `)/[` with no close on the line do not make masking quadratic', () => {
    const time = (n: number) => {
      const code = `const x = ${'(a)/['.repeat(n)}\n`
      const t = performance.now()
      anonymize(code, { language: 'typescript' })
      return performance.now() - t
    }
    const small = time(4000)
    const large = time(16000)
    expect(large / Math.max(small, 25)).toBeLessThan(10)
  })
})

// Review of R2-11: the retry after a division read a Ruby comment holding `/`
// as a regex, and `%=` opened a %-literal that ran to the next `=`.
describe('Ruby comments and operators read as before (R2-11 review)', () => {
  it('a comment after a division keeps its words', () => {
    const out = anonymize('total = a / b # see https://example.invalid and/or PaymentNote\n', {
      language: 'ruby',
    }).anonymized
    expect(out).toContain('# see https://example.invalid and/or PaymentNote')
  })

  it('`%=` is an operator, and a later `#` in a string opens no comment', () => {
    const out = anonymize('i %= n\nputs "a=b #PaymentGateway"\nclass PaymentGateway; end\n', {
      language: 'ruby',
    }).anonymized
    expect(out).not.toContain('PaymentGateway')
  })

  it('`% ` with a space is an operator', () => {
    const out = anonymize('x = y % z\nclass PaymentGateway; end # note\n', {
      language: 'ruby',
    }).anonymized
    expect(out).not.toContain('PaymentGateway')
    expect(out).toContain('# note')
  })
})

// Security review of R2-11: a bare `%` takes any non-word, non-space
// delimiter in Ruby (`%|..|`, `%!..!`), not only a bracket.
describe('Ruby %-literals with any delimiter (R2-11 security review)', () => {
  for (const [open, close] of [
    ['|', '|'],
    ['!', '!'],
    ['^', '^'],
  ])
    it(`\`%${open}..#Name..${close}\` is a string, not a comment`, () => {
      const out = anonymize(
        `class PaymentGateway; end\ntext = %${open}see #PaymentGateway here${close}\n`,
        { language: 'ruby' }
      ).anonymized
      expect(out).not.toContain('PaymentGateway')
    })

  it('`x % y` and `x %= 2` stay operators', () => {
    const out = anonymize('x = y % z # note one\nx %= 2 # note two\n', {
      language: 'ruby',
    }).anonymized
    expect(out).toContain('# note one')
    expect(out).toContain('# note two')
  })
})

// Security review round 2 of R2-11: after an operand and a space, `%` is
// modulo; a bare `%` with a symbol delimiter opens a literal only where
// Ruby's lexer starts an expression, or after a method-call keyword.
describe('Ruby % as an operator or a literal, as the lexer reads it (R2-11 review 2)', () => {
  const ruby = (code: string) => anonymize(code, { language: 'ruby' }).anonymized

  it.each([
    'x = y % z # note kept\nw = 1 % 2\n',
    'x = y %-z # note kept\nw = 1 - 2\n',
    'r = a %|b # note kept\nq = c | d\n',
    // Symbol delimiters are only | ! ^ / ~ (security review round 2).
    'w = %-y # note kept\nz = 1 - 2\n',
  ])('operator: %j', (code) => {
    expect(ruby(code)).toContain('# note kept')
  })

  it.each([
    'class PaymentGateway; end\nputs %|see #PaymentGateway|\n',
    'class PaymentGateway; end\nx = %!see #PaymentGateway!\n',
    'class PaymentGateway; end\nlist = [%^see #PaymentGateway^]\n',
    'class PaymentGateway; end\n%/see #PaymentGateway/\n',
  ])('literal: %j', (code) => {
    expect(ruby(code)).not.toContain('PaymentGateway')
  })
})
