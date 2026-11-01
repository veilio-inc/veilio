/**
 * Inputs whose masking without the `team` option must stay byte-identical to
 * the engine before spec 066 (tests/team-numbering.test.ts). The snapshot was
 * written by the 065 engine, before the option existed.
 */
import type { AnonymizeOptions } from '../../src/index.js'

const TS = `import { ledgerClient } from './quayward/ledger'

export class SettlementPlanner {
  private pendingBatches: Map<string, number> = new Map()

  constructor(private readonly ledger = ledgerClient) {}

  /** Plans the next settlement for one counterparty. */
  async planSettlement(counterpartyId: string, amountMinor: number) {
    const existingBatch = this.pendingBatches.get(counterpartyId) ?? 0
    const message = \`settling \${counterpartyId} for \${amountMinor}\`
    await this.ledger.recordIntent(counterpartyId, existingBatch + amountMinor, message)
    return { counterpartyId, total: existingBatch + amountMinor }
  }
}
`

const PY = `from quayward.billing import invoice_store

IBAN_ON_FILE = "DE89370400440532013000"

def reconcile_invoices(customer_ref, cutoff_days=30):
    """Reconcile open invoices for Janina Kowalska's account."""
    open_items = invoice_store.fetch_open(customer_ref)
    stale = [item for item in open_items if item.age_days > cutoff_days]
    return summarise_stale(stale, account="DE89370400440532013000")
`

const JAVA = `package com.quayward.routing;

public final class SkerryRouteBalancer {
    private final int harbourCapacity;

    public SkerryRouteBalancer(int harbourCapacity) {
        this.harbourCapacity = harbourCapacity;
    }

    public int rebalanceBerths(int requestedBerths) {
        int clampedBerths = Math.min(requestedBerths, harbourCapacity);
        return clampedBerths;
    }
}
`

const rule = (placeholder: string, pattern: string) =>
  ({
    id: `r-${placeholder}`,
    scope: 'team',
    team_id: 't',
    name: placeholder,
    type: 'replace',
    pattern,
    placeholder,
    enabled: true,
    sort_order: 0,
  }) as const

export const NUMBERING_CORPUS: ReadonlyArray<readonly [string, string, AnonymizeOptions]> = [
  ['typescript, plain', TS, { language: 'typescript' }],
  [
    'typescript over an existing map',
    TS,
    {
      language: 'typescript',
      existingMap: { __CLS__41: 'SettlementPlanner', __VAR__7: 'ledger', __FN__90: 'elsewhere' },
    },
  ],
  [
    'typescript with a replace rule',
    TS,
    { language: 'typescript', rules: [rule('__CODENAME__', '^counterparty')] },
  ],
  [
    'python with a regulated value and a manual mark',
    PY,
    { language: 'python', manual: ['Janina Kowalska'] },
  ],
  [
    'python over a map holding a manual mark and an IBAN',
    PY,
    {
      language: 'python',
      existingMap: { __MANUAL__3: 'Janina Kowalska', __IBAN__2: 'GB82WEST12345698765432' },
    },
  ],
  ['java, plain', JAVA, { language: 'java' }],
  [
    'java, text already holding placeholders',
    `${JAVA}\n// see __CLS__12 and __VAR__300\n`,
    { language: 'java' },
  ],
]
