/**
 * The restore rule, as cases every surface must agree on (spec 028, SC-002).
 * Run by the engine's own tests, and by the CLI's `restore` and the MCP's
 * `restore_text` tests, so "the same everywhere" is one fixture, not three
 * claims.
 */
export interface RestoreCase {
  name: string
  own: Record<string, string>
  team: {
    namespace: Record<string, string>
    aliases: Record<string, string>
    conflicts: Record<string, number>
  } | null
  text: string
  restored: string
  disputed: string[]
  /** Own entries the team layer contradicts: locally numbered, left and named (spec 028 R5). */
  locallyNumbered?: string[]
}

const team = (over: Partial<NonNullable<RestoreCase['team']>> = {}) => ({
  namespace: {},
  aliases: {},
  conflicts: {},
  ...over,
})

export const RESTORE_CASES: RestoreCase[] = [
  {
    name: "a teammate's placeholder, known only to the team",
    own: {},
    team: team({ namespace: { __FN__1: 'settleLedger' } }),
    text: 'ledger.__FN__1()',
    restored: 'ledger.settleLedger()',
    disputed: [],
  },
  {
    name: 'an alias restores to its identifier',
    own: {},
    team: team({ namespace: { __FN__3: 'voidLedger' }, aliases: { __FN__7: 'voidLedger' } }),
    text: '__FN__7(); __FN__3()',
    restored: 'voidLedger(); voidLedger()',
    disputed: [],
  },
  {
    name: 'a disputed placeholder is left and named',
    own: {},
    team: team({
      namespace: { __FN__6: 'settleLedger', __VAR__1: 'customerId' },
      conflicts: { __FN__6: 2 },
    }),
    text: 'a __FN__6 b __VAR__1',
    restored: 'a __FN__6 b customerId',
    disputed: ['__FN__6'],
  },
  {
    name: 'a disputed placeholder the own map defines is restored to the own meaning',
    own: { __FN__6: 'voidLedger' },
    team: team({ namespace: { __FN__6: 'settleLedger' }, conflicts: { __FN__6: 2 } }),
    text: 'a __FN__6',
    restored: 'a voidLedger',
    disputed: [],
  },
  {
    name: 'a disputed placeholder not in the text is not named',
    own: {},
    team: team({
      namespace: { __FN__6: 'settleLedger', __FN__2: 'createInvoice' },
      conflicts: { __FN__6: 2 },
    }),
    text: '__FN__2()',
    restored: 'createInvoice()',
    disputed: [],
  },
  {
    name: 'a locally numbered own entry the team contradicts is left and named, not restored',
    own: { __CLS__1: 'Foo' },
    team: team({ namespace: { __CLS__1: 'Bar', __FN__2: 'createInvoice' } }),
    text: 'new __CLS__1().__FN__2()',
    restored: 'new __CLS__1().createInvoice()',
    disputed: [],
    locallyNumbered: ['__CLS__1'],
  },
  {
    name: 'an own entry the team agrees with, or does not know, restores',
    own: { __FN__2: 'createInvoice', __FN__30: 'brandNew' },
    team: team({ namespace: { __FN__2: 'createInvoice' } }),
    text: '__FN__2(); __FN__30()',
    restored: 'createInvoice(); brandNew()',
    disputed: [],
  },
  {
    name: 'no team: the own map only',
    own: { __CLS__1: 'PaymentGateway' },
    team: null,
    text: 'new __CLS__1()',
    restored: 'new PaymentGateway()',
    disputed: [],
  },
]
