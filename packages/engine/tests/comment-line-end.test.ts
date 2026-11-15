import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'

// Spec 094: a line comment ends where the line ends - at a line feed, at a
// carriage return standing alone (old Mac line endings), at U+2028 and at
// U+2029 - so the code after it is masked.

const NAMES = ['AcmePay', 'settleInvoice', 'acme_refunds']
const ENDS = [
  ['a lone CR', '\r'],
  ['U+2028', ' '],
  ['U+2029', ' '],
] as const
const CODE = [
  [
    'typescript',
    '//',
    (end: string) => `class AcmePay {${end}  settleInvoice(acme_refunds) {}${end}}${end}`,
  ],
  [
    'python',
    '#',
    (end: string) =>
      `class AcmePay:${end}    def settleInvoice(self, acme_refunds):${end}        return acme_refunds${end}`,
  ],
  [
    'ruby',
    '#',
    (end: string) =>
      `class AcmePay${end}  def settleInvoice(acme_refunds)${end}  end${end}end${end}`,
  ],
  ['sql', '--', (end: string) => `SELECT acme_refunds FROM AcmePay.settleInvoice;${end}`],
] as const

describe('a line comment ends at every line terminator', () => {
  for (const [language, opener, write] of CODE)
    for (const [label, end] of ENDS)
      it(`${opener} in ${language}, before ${label}`, () => {
        const code = `${opener} header${end}${write(end)}`
        const { anonymized, map, comments } = anonymize(code, { language })
        for (const name of NAMES) {
          expect(anonymized).not.toContain(name)
          expect(Object.values(map)).toContain(name)
        }
        expect(anonymized.startsWith(`${opener} header${end}`)).toBe(true)
        expect(comments.total).toBe(1)
        expect(restore(anonymized, map).restored).toBe(code)
      })

  it('a comment at the end of a line of code, before a lone CR', () => {
    const code = 'const total = 1 // note\rclass AcmePay { settleInvoice(acme_refunds) {} }\r'
    const { anonymized, map } = anonymize(code, { language: 'typescript' })
    for (const name of NAMES) expect(anonymized).not.toContain(name)
    expect(anonymized).toContain('// note\r')
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('a file of mixed line endings', () => {
    const code =
      '// one\r\nconst customerTotal = 1 // two\rclass AcmePay {}\n// three const acmeCorp = 2\r\n'
    const { anonymized, map, comments } = anonymize(code, { language: 'typescript' })
    for (const name of ['customerTotal', 'AcmePay', 'acmeCorp']) {
      expect(anonymized).not.toContain(name)
      expect(Object.values(map)).toContain(name)
    }
    expect(comments.total).toBe(3)
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('a CRLF file reads as its LF twin does', () => {
    const lf = '// The PaymentGateway client.\nconst customerTotal = 1 // running total\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const a = anonymize(lf, { language: 'typescript' })
    const b = anonymize(crlf, { language: 'typescript' })
    expect(b.anonymized).toBe(a.anonymized.replace(/\n/g, '\r\n'))
    expect(b.map).toEqual(a.map)
    // The exact count of a CRLF file is held by the 1.19.2 baseline rows.
    expect(b.comments.total).toBe(a.comments.total)
    expect(b.anonymized).toContain('// The PaymentGateway client.\r\n')
  })
})
