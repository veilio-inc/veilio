import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'

// Spec 094: a Python triple-quoted literal is documentation only where a
// docstring stands - alone, as the first statement of a module, a class or a
// function. Anywhere else it is a string, and masked like one: an assigned
// query, an f-string, an argument, a dictionary value.

const NAMES = [
  'AcmePay',
  'AcmeLedger',
  'settleInvoice',
  'customerTotal',
  'acme_refunds',
  'acme_corp',
  'acmeCorp',
]
const python = (code: string) => anonymize(code, { language: 'python' })

/** Every planted name of `code` is a placeholder in the output and a value of
 *  the map, and the text comes back exactly. */
function masked(code: string) {
  const result = python(code)
  const planted = NAMES.filter((name) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code))
  expect(planted.length).toBeGreaterThan(0)
  for (const name of planted) {
    expect(result.anonymized).not.toMatch(new RegExp(`(?<![\\w$])${name}(?![\\w$])`))
    expect(Object.values(result.map)).toContain(name)
  }
  expect(restore(result.anonymized, result.map).restored).toBe(code)
  return result
}

/** The text is left exactly as written, and counted as a comment. */
function documentation(code: string, text: string) {
  const result = python(code)
  expect(result.anonymized).toContain(text)
  expect(result.comments.total).toBeGreaterThan(0)
  expect(restore(result.anonymized, result.map).restored).toBe(code)
  return result
}

describe('a triple-quoted literal outside docstring position is a string', () => {
  it.each([
    [
      'an assigned query',
      `query = """\n    SELECT acme_refunds, customerTotal FROM acme_corp.AcmeLedger WHERE owner = 'AcmePay'\n"""\n`,
    ],
    ['an f-string', 'def go(acmeCorp):\n    return f"""{acmeCorp.acme_refunds} {AcmePay}"""\n'],
    ['a call argument', "log.info('''AcmePay settleInvoice failed for acme_refunds''', x)\n"],
    ['a dictionary value', 'd = {"k": """acme_corp"""}\n'],
    [
      'a call argument on its own line',
      'cursor.execute(\n    """\n    UPDATE acme_corp.AcmeLedger SET customerTotal = 0\n    """,\n    params,\n)\n',
    ],
    [
      'a dictionary value on its own line',
      'QUERIES = {\n    "refunds":\n        """SELECT acme_refunds FROM acme_corp""",\n}\n',
    ],
    [
      'a returned value',
      'def query():\n    return """SELECT customerTotal FROM acme_corp.AcmeLedger"""\n',
    ],
    [
      'a literal after a decorator argument',
      '@route("""/acme_corp/settleInvoice""")\ndef handler():\n    return 1\n',
    ],
  ])('%s', (_, code) => {
    masked(code)
  })

  it.each(['f', 'r', 'b', 'u', 'rb', 'F', 'R', 'Rb', 'BR'])('with the prefix %s', (prefix) => {
    masked(`text = ${prefix}"""AcmePay settleInvoice for acme_refunds"""\n`)
    // Also where a docstring would stand: a prefixed literal is never one.
    masked(`def run():\n    ${prefix}"""AcmePay settleInvoice for acme_refunds"""\n`)
  })

  it.each(['"""', "'''"])('gives the words the placeholders a one-quote string gives (%s)', (q) => {
    const words = 'AcmePay settleInvoice for acme_refunds'
    const triple = python(`text = ${q}${words}${q}\n`)
    const single = python(`text = ${q[0]}${words}${q[0]}\n`)
    expect(triple.map).toEqual(single.map)
    expect(triple.anonymized.split(q).join(q[0]!)).toBe(single.anonymized)
  })

  it.each([
    [
      'after a class attribute',
      'class Ledger:\n    limit = 5\n    """The customerTotal limit of acme_corp."""\n',
    ],
    ['under if', 'if ready:\n    """AcmePay settleInvoice for acme_refunds"""\n    run()\n'],
    ['under try', 'try:\n    """AcmePay settleInvoice for acme_refunds"""\nfinally:\n    run()\n'],
    [
      'directly after the docstring',
      '"""Module of the ledger."""\n"""AcmePay settleInvoice for acme_refunds"""\nimport os\n',
    ],
    ['after an import', 'import os\n"""AcmePay settleInvoice for acme_refunds"""\n'],
    [
      'with code after it on its line',
      'def run():\n    """AcmePay settleInvoice""".format(acme_refunds)\n',
    ],
  ])('a bare literal %s', (_, code) => {
    masked(code)
  })

  it('a literal never closed is a string to the end of the text', () => {
    const code = 'query = """\n    SELECT acme_refunds FROM acme_corp.AcmeLedger\nimport os\n'
    const { comments } = masked(code)
    expect(comments.total).toBe(0)
  })

  it('a literal never closed at the start of the text is a string too', () => {
    masked('"""\nSELECT acme_refunds FROM acme_corp.AcmeLedger\n')
  })

  it('a credential inside one is still redacted', () => {
    const key = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('')
    const { anonymized, map } = python(`text = f"""token ${key} for {acmeCorp}"""\n`)
    expect(anonymized).toContain('__REDACTED_GITHUB_TOKEN_1__')
    expect(anonymized).not.toContain('acmeCorp')
    expect(JSON.stringify(map)).not.toContain(key.slice(8, 20))
  })
})

describe('a docstring is left as written', () => {
  it('of a module, a class and a function', () => {
    const code = `#!/usr/bin/env python3
# The ledger.
"""Ledger module.

Talks to the PaymentGateway.
"""


class Ledger:
    '''Keeps one total for PaymentGateway.'''

    def settle(self, invoice):
        """Send one invoice to the PaymentGateway."""
        return invoice
`
    const result = documentation(code, 'Talks to the PaymentGateway.')
    expect(result.anonymized).toContain("'''Keeps one total for PaymentGateway.'''")
    expect(result.anonymized).toContain('"""Send one invoice to the PaymentGateway."""')
    // Counted as before the change.
    expect(result.comments).toMatchObject({ total: 3, inline: 2, characters: 169 })
  })

  it.each([
    ['on the header line', 'def settle(invoice): """Send to the PaymentGateway."""\n'],
    [
      'after a header over several lines',
      'async def settle(\n    invoice,\n    retries={"a": 3}[key],\n) -> dict[str, int]:\n    """Send to the PaymentGateway."""\n    return {}\n',
    ],
    [
      'after a class header with bases',
      'class Ledger(Base, metaclass=Meta):\n\n    """Send to the PaymentGateway."""\n',
    ],
    [
      'after a comment line',
      'def settle(invoice):\n    # how\n    """Send to the PaymentGateway."""\n',
    ],
    [
      'followed by a comment',
      'def settle(invoice):\n    """Send to the PaymentGateway."""  # short\n    return invoice\n',
    ],
    [
      'after a default that holds a colon',
      'def settle(invoice, sep=":"):\n    """Send to the PaymentGateway."""\n',
    ],
  ])('%s', (_, code) => {
    documentation(code, '"""Send to the PaymentGateway."""')
  })

  // Open question of the spec, answered "as before" for now: a text cut out of
  // a file cannot tell an opening triple quote from a closing one.
  it('a text that starts with a closed triple-quoted literal reads it as the module docstring', () => {
    documentation('"""\nSends to the PaymentGateway.\n"""\nimport os\n', 'PaymentGateway')
  })
})
