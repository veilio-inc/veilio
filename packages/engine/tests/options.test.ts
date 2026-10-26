import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import { detectSecrets, scanSecrets } from '../src/secrets.js'
import type { AnonymizeOptions, RestoreOptions, SymbolMap } from '../src/types.js'

// An options object and a positional symbol map were told apart by a guess:
// an object that named none of four option keys and held only strings was a
// map. So `{ style: 'plain' }` - an option removed before 1.0.0 that the
// README kept documenting - was taken as a map, the call ran, and the key was
// stored in the map, which then reached Cloud on `maps push`. Any typo did the
// same. Now the keys decide: all placeholders is a map, all option names is
// options, anything else throws.

const CODE = 'class PaymentService { charge(amount) { return amount } }'
const VALID = 'existingMap, rules, manual, language, secrets, path'

/** Call with an object the type system would refuse, as a JS caller can. */
const loose = (o: object) => o as unknown as AnonymizeOptions

describe('anonymize refuses an option it does not know', () => {
  // `style` is the one option the docs ever named that the engine removed
  // (a5c494b: `style?: 'roles' | 'plain'`); the rest are typos and options of
  // other functions.
  const refused: [object, string][] = [
    [{ style: 'plain' }, 'style'],
    [{ style: 'roles' }, 'style'],
    [{ secret: 'off' }, 'secret'],
    [{ lang: 'go' }, 'lang'],
    [{ language: 'go', style: 'plain' }, 'style'],
    [{ existing_map: {} }, 'existing_map'],
    [{ strip: 'none' }, 'strip'],
    [{ map: {} }, 'map'],
  ]
  for (const [options, key] of refused) {
    it(`throws on ${JSON.stringify(options)}, naming '${key}'`, () => {
      expect(() => anonymize(CODE, loose(options))).toThrow(TypeError)
      expect(() => anonymize(CODE, loose(options))).toThrow(
        `anonymize: unknown option '${key}'. Valid options: ${VALID}.`
      )
    })
  }

  it('names every unknown key', () => {
    expect(() => anonymize(CODE, loose({ style: 'plain', lang: 'go' }))).toThrow(
      `anonymize: unknown options 'style', 'lang'. Valid options: ${VALID}.`
    )
  })

  it('never stores the key: the old behaviour put "style" in the map', () => {
    let map: SymbolMap | undefined
    try {
      map = anonymize(CODE, loose({ style: 'plain' })).map
    } catch {
      // expected
    }
    expect(map).toBeUndefined()
  })

  it('refuses a map mixed with a junk key, naming only the junk', () => {
    const mixed = { __CLS__1: 'PaymentService', style: 'plain' }
    expect(() => anonymize(CODE, loose(mixed))).toThrow(
      `anonymize: unknown option 'style'. Valid options: ${VALID}.`
    )
  })

  it('refuses options mixed with map placeholders, and says where the map goes', () => {
    const mixed = { language: 'typescript', __CLS__1: 'PaymentService' }
    expect(() => anonymize(CODE, loose(mixed))).toThrow(
      "anonymize: options cannot also hold map placeholders ('__CLS__1'). Pass the map as { existingMap }."
    )
  })
})

describe('anonymize still accepts what it accepted', () => {
  it('{} and no argument: no options', () => {
    expect(anonymize(CODE, {}).map).toEqual(anonymize(CODE).map)
    expect(anonymize(CODE, undefined).map).toEqual(anonymize(CODE).map)
  })

  it('a real existing map, positionally (deprecated form)', () => {
    const first = anonymize(CODE)
    const again = anonymize('class RefundService {}', first.map)
    expect(again.map).toMatchObject(first.map)
    expect(Object.values(again.map)).toContain('RefundService')
    expect(again.anonymized).not.toContain('RefundService')
    // Numbering continues from the map: the new class is not __CLS__1.
    expect(again.map.__CLS__1).toBe('PaymentService')
  })

  it('a map of every placeholder kind, positionally', () => {
    const map: SymbolMap = {
      __CLS__1: 'PaymentService',
      __FN__2: 'charge',
      __VAR__3: 'amount',
      __MANUAL__1: 'Kowalska',
      __IBAN__1: 'GB82WEST12345698765432',
      __PAN__1: '4539578763621486',
      __PESEL__1: '44051401359',
      __P1__: 'legacy',
      __APIKEY__1: 'named by a replace rule',
      __CLS__1001: 'locally numbered',
    }
    expect(() => anonymize(CODE, map)).not.toThrow()
    expect(anonymize(CODE, map).map).toMatchObject(map)
  })

  it('{ existingMap }', () => {
    const first = anonymize(CODE)
    const again = anonymize('class RefundService {}', { existingMap: first.map })
    expect(again.map).toMatchObject(first.map)
  })

  const each: [keyof AnonymizeOptions, unknown][] = [
    ['existingMap', {}],
    ['rules', []],
    ['manual', ['PaymentService']],
    ['language', 'typescript'],
    ['secrets', 'warn'],
    ['path', 'src/payment.ts'],
  ]
  for (const [key, value] of each) {
    it(`{ ${key} } alone is options`, () => {
      expect(() => anonymize(CODE, { [key]: value })).not.toThrow()
    })
  }

  it('an option set to undefined is still an option', () => {
    expect(() => anonymize(CODE, { language: undefined, path: undefined })).not.toThrow()
  })
})

describe('restore refuses an option it does not know', () => {
  const looseRestore = (o: object) => o as unknown as RestoreOptions
  for (const [options, key] of [
    [{ style: 'plain' }, 'style'],
    [{ stripp: 'none' }, 'stripp'],
    [{ strip: 'none', keepDocs: true }, 'keepDocs'],
  ] as [object, string][]) {
    it(`throws on ${JSON.stringify(options)}`, () => {
      expect(() => restore('__CLS__1', { __CLS__1: 'A' }, looseRestore(options))).toThrow(
        `restore: unknown option '${key}'. Valid options: strip.`
      )
    })
  }
  it('accepts {}, no options and { strip }', () => {
    const map = { __CLS__1: 'A' }
    expect(restore('__CLS__1', map).restored).toBe('A')
    expect(restore('__CLS__1', map, {}).restored).toBe('A')
    expect(restore('__CLS__1', map, { strip: 'none' }).restored).toBe('A')
  })
})

describe('scanSecrets and detectSecrets refuse an option they do not know', () => {
  it('throws on a misspelt path', () => {
    const bad = { file: 'tests/x.test.ts' } as unknown as { path?: string }
    expect(() => scanSecrets('x', 'redact', bad)).toThrow(
      "scanSecrets: unknown option 'file'. Valid options: path."
    )
    expect(() => detectSecrets('x', bad)).toThrow(
      "detectSecrets: unknown option 'file'. Valid options: path."
    )
  })
  it('accepts { path } and {}', () => {
    expect(() => scanSecrets('x', 'redact', { path: 'a.ts' })).not.toThrow()
    expect(() => detectSecrets('x', {})).not.toThrow()
  })
})
