import { describe, it, expect } from 'vitest'
import { classifyIdentifiers, ROLE_BASES, extractIdentifiers } from '../src/engine.js'

describe('classifyIdentifiers — role signals', () => {
  it('classifies class-keyword contexts as class', () => {
    const roles = classifyIdentifiers(
      'class PaymentService extends BaseService implements Billable {}\n' +
        'interface AuthShape {}\nenum OrderKind {}\nconst x = new TokenVault()'
    )
    expect(roles.PaymentService).toBe('class')
    expect(roles.BaseService).toBe('class')
    expect(roles.Billable).toBe('class')
    expect(roles.AuthShape).toBe('class')
    expect(roles.OrderKind).toBe('class')
    expect(roles.TokenVault).toBe('class')
  })

  it('classifies function keyword and call-shaped usage as function', () => {
    const roles = classifyIdentifiers('function calcVat(net) { return applyRate(net) }')
    expect(roles.calcVat).toBe('function')
    expect(roles.applyRate).toBe('function')
  })

  it('allows whitespace between name and open paren', () => {
    const roles = classifyIdentifiers('resolveThing ()')
    expect(roles.resolveThing).toBe('function')
  })

  it('classifies method calls after a dot as function', () => {
    const roles = classifyIdentifiers('gateway.chargeCard(amount)')
    expect(roles.chargeCard).toBe('function')
    expect(roles.gateway).toBe('variable')
    expect(roles.amount).toBe('variable')
  })

  it('classifies def-declared names as function (python-ish input)', () => {
    const roles = classifyIdentifiers('def calculate_commission(client_rate): pass')
    expect(roles.calculate_commission).toBe('function')
  })

  it('classifies module-specifier strings as package', () => {
    const roles = classifyIdentifiers(
      "import { createClient } from '@supabase/supabase-js'\n" +
        "const lodash = require('lodash')\nconst mod = import('dynamic-pkg')\nimport 'bare-polyfill'"
    )
    expect(roles.supabase).toBe('package')
    expect(roles.lodash).toBe('package') // package outranks variable
    expect(roles.dynamic).toBe('package')
    expect(roles.bare).toBe('package')
    expect(roles.polyfill).toBe('package')
  })

  it('classifies words seen ONLY inside ordinary strings as string', () => {
    const roles = classifyIdentifiers('logger.info("failed parsing customer invoice")')
    expect(roles.failed).toBe('string')
    expect(roles.parsing).toBe('string')
    expect(roles.customer).toBe('string')
    expect(roles.invoice).toBe('string')
  })

  it('keyword-named words inside strings and module specifiers still get roles', () => {
    const roles = classifyIdentifiers(
      "import path from 'path'\nconst c = require('crypto')\nlog(\"please return the item\")"
    )
    expect(roles.path).toBe('package')
    expect(roles.crypto).toBe('package')
    expect(roles.return).toBe('string')
    expect(roles.item).toBe('string')
  })

  it('falls back to class for PascalCase names with no stronger signal', () => {
    const roles = classifyIdentifiers('const x: OrderDto = y')
    expect(roles.OrderDto).toBe('class')
  })

  it('defaults to variable when no signal matches', () => {
    const roles = classifyIdentifiers('const grandTotal = subTotal + taxPart')
    expect(roles.grandTotal).toBe('variable')
    expect(roles.subTotal).toBe('variable')
    expect(roles.taxPart).toBe('variable')
  })

  it('never assigns roles to reserved words (negative)', () => {
    const roles = classifyIdentifiers('if (cond) { return new Widget() } from')
    expect(roles.if).toBeUndefined()
    expect(roles.return).toBeUndefined()
    expect(roles.new).toBeUndefined()
    expect(roles.from).toBeUndefined()
    expect(roles.Widget).toBe('class') // keyword context still works
    expect(roles.cond).toBe('variable')
  })
})

describe('classifyIdentifiers — priority resolution across occurrences', () => {
  it('code occurrence outranks string occurrence', () => {
    const roles = classifyIdentifiers('const retryCount = 3\nlog("retryCount exceeded")')
    expect(roles.retryCount).toBe('variable')
  })

  it('class keyword outranks call-shaped usage', () => {
    const roles = classifyIdentifiers('new OrderRouter()\nOrderRouter(config)')
    expect(roles.OrderRouter).toBe('class')
  })

  it('function outranks package for a name in both roles', () => {
    const roles = classifyIdentifiers("import x from 'helperlib'\nhelperlib(1)")
    expect(roles.helperlib).toBe('function')
  })
})

describe('classifyIdentifiers — negative and edge cases', () => {
  it('ignores comment contents entirely', () => {
    const roles = classifyIdentifiers(
      '// secretHelper does things\n/* also secretHelper */\nconst a = 1'
    )
    expect(roles.secretHelper).toBeUndefined()
  })

  it('returns an empty record for empty and whitespace-only input', () => {
    expect(classifyIdentifiers('')).toEqual({})
    expect(classifyIdentifiers('   \n\t ')).toEqual({})
  })

  it('a string containing require-like prose is not a module specifier', () => {
    const roles = classifyIdentifiers('const hint = "please require assistance"')
    expect(roles.assistance).toBe('string')
  })
})

describe('ROLE_BASES', () => {
  it('maps every role to its documented placeholder base', () => {
    expect(ROLE_BASES).toEqual({
      class: '__CLS__',
      function: '__FN__',
      package: '__PKG__',
      variable: '__VAR__',
      string: '__STR__',
    })
  })
})

import { anonymize, restore } from '../src/engine.js'
import type { CustomRuleReplace, CustomRuleWhitelist } from '../src/types.js'

describe('anonymize — role-typed placeholders', () => {
  it('emits role-based placeholders by default', () => {
    const { anonymized, map } = anonymize('class UserAuthService { validateToken() {} }')
    expect(anonymized).toBe('class __CLS__1 { __FN__1() {} }')
    expect(map).toEqual({ __CLS__1: 'UserAuthService', __FN__1: 'validateToken' })
  })

  it('numbers each role base independently', () => {
    const { map } = anonymize('class Alpha {}\nclass Bravo {}\nfunction charlie() {}')
    expect(map.__CLS__1).toBeDefined()
    expect(map.__CLS__2).toBeDefined()
    expect(map.__FN__1).toBe('charlie')
  })

  it('round-trips verbatim under role placeholders', () => {
    const code = 'class TaxEngine { compute(netAmount) { return netAmount * 0.23 } }'
    const { anonymized, map } = anonymize(code)
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('emits a role-typed placeholder for a class declaration', () => {
    const { anonymized, map } = anonymize('class UserAuthService {}')
    expect(anonymized).toBe('class __CLS__1 {}')
    expect(map).toEqual({ __CLS__1: 'UserAuthService' })
  })
})

describe('anonymize — options disambiguation (negative)', () => {
  it('does NOT treat an all-string options object as an existingMap', () => {
    // Every value in { language: 'go' } is a string, so a naive isSymbolMap
    // check would seed reverseExisting with the option value itself.
    const { map } = anonymize('func settleLedger() {}', { language: 'go' })
    expect(Object.values(map)).not.toContain('go')
    expect(Object.values(map)).toContain('settleLedger')
  })

  it('still accepts the legacy positional SymbolMap argument', () => {
    const { map } = anonymize('doThing()', { __FN__3: 'doThing' })
    // Already mapped: no new placeholder, numbering seeded past 3
    expect(Object.entries(map)).toEqual([['__FN__3', 'doThing']])
  })
})

describe('anonymize — roles with existing maps and rules', () => {
  it('keeps legacy __P<n>__ mappings and gives only NEW identifiers role placeholders', () => {
    const existing = { __P1__: 'PaymentService' }
    const { anonymized, map } = anonymize('class PaymentService { chargeCard() {} }', {
      existingMap: existing,
    })
    expect(anonymized).toBe('class __P1__ { __FN__1() {} }')
    expect(map.__P1__).toBe('PaymentService')
    expect(map.__FN__1).toBe('chargeCard')
  })

  it('continues role counters from an existing role map', () => {
    const { map } = anonymize('class Newcomer {}', { existingMap: { __CLS__4: 'OldTimer' } })
    expect(map.__CLS__5).toBe('Newcomer')
  })

  it('whitelist rules still win over role placeholders (negative)', () => {
    const wl: CustomRuleWhitelist = {
      id: 'w1',
      scope: 'personal',
      team_id: null,
      type: 'whitelist',
      name: 'keep',
      pattern: '^KeepMe$',
      enabled: true,
      sort_order: 1,
    }
    const { anonymized, map } = anonymize('class KeepMe {}', { rules: [wl] })
    expect(anonymized).toBe('class KeepMe {}')
    expect(Object.values(map)).not.toContain('KeepMe')
  })

  it('replace rules still win over role placeholders (negative)', () => {
    const rr: CustomRuleReplace = {
      id: 'r1',
      scope: 'personal',
      team_id: null,
      type: 'replace',
      name: 'keys',
      pattern: 'ApiKey$',
      placeholder: '__APIKEY__',
      enabled: true,
      sort_order: 1,
    }
    const { map } = anonymize('const stripeApiKey = load()', { rules: [rr] })
    expect(map.__APIKEY__1).toBe('stripeApiKey')
    expect(Object.values(map)).toContain('load')
  })

  it('a custom rule sharing a role base shares its counter (documented behavior)', () => {
    const rr: CustomRuleReplace = {
      id: 'r2',
      scope: 'personal',
      team_id: null,
      type: 'replace',
      name: 'fns',
      pattern: '^special',
      placeholder: '__FN__',
      enabled: true,
      sort_order: 1,
    }
    const { map } = anonymize('specialThing = 1\nplainHelper()', { rules: [rr] })
    const fnKeys = Object.keys(map).filter((k) => k.startsWith('__FN__'))
    expect(fnKeys).toHaveLength(2)
    expect(new Set(fnKeys).size).toBe(2) // no collision/overwrite
  })
})

describe('idempotency — placeholder-shaped tokens are never re-masked', () => {
  it('extractIdentifiers skips __P<n>__, role, and custom-named placeholders', () => {
    const ids = extractIdentifiers('__P1__ __CLS__2 __FN__10 __APIKEY__3 __API_KEY__7 realName')
    expect(ids).toEqual(['realName'])
  })

  it('anonymizing already-anonymized code is a no-op', () => {
    const first = anonymize('class UserAuthService { validateToken() {} }')
    const second = anonymize(first.anonymized)
    expect(second.anonymized).toBe(first.anonymized)
    expect(second.map).toEqual({})
  })

  it('double anonymize→restore returns the original', () => {
    const code = 'class OrderRouter { route(orderId) {} }'
    const first = anonymize(code)
    const second = anonymize(first.anonymized)
    expect(restore(second.anonymized, first.map).restored).toBe(code)
  })

  it('documented trade-off: user tokens shaped like placeholders stay unmasked', () => {
    // e.g. React Native's __DEV__ global — placeholder-shaped, left verbatim.
    const { anonymized } = anonymize('if (__DEV__) { debugFlag = true }')
    expect(anonymized).toContain('__DEV__')
    expect(anonymized).not.toContain('debugFlag')
  })

  it('continues numbering past placeholder tokens already present in the code', () => {
    const { anonymized, map } = anonymize(
      'class __CLS__1 { helper() {} }\nclass BrandNewService {}'
    )
    expect(map.__CLS__2).toBe('BrandNewService')
    expect(anonymized).toContain('class __CLS__1 {')
    expect(anonymized).toContain('class __CLS__2 {}')
    expect(map.__CLS__1).toBeUndefined()
  })

  it('continues numbering past a role placeholder already in the source', () => {
    // __FN__3 is preserved by the idempotency guard, so a fresh function name
    // must land at __FN__4 rather than colliding at __FN__1.
    const { map } = anonymize('const __FN__3 = 1\nrealThing()')
    expect(map.__FN__4).toBe('realThing')
  })
})
