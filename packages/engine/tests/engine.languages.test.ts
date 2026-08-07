import { describe, it, expect } from 'vitest'
import { anonymize, restore, extractIdentifiers, classifyIdentifiers } from '../src/engine.js'
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  classKeywordsFor,
  commentSyntaxFor,
  detectLanguage,
  fnKeywordsFor,
  guessLanguage,
  isKeyword,
  keywordsFor,
  resolveLanguage,
  type Language,
} from '../src/languages.js'

// Each sample is real-shaped code for its language, paired with the reserved
// words and built-ins that MUST survive masking (masking them makes the output
// unreadable as source, which is the bug this module exists to fix) and the
// proprietary identifiers that MUST NOT survive.
const SAMPLES: Record<Language, { code: string; keep: string[]; mask: string[] }> = {
  typescript: {
    code: `import { Router } from 'express'
export class PaymentGateway {
  async chargeCard(amount: number): Promise<boolean> {
    const receipt = await this.processor.settle(amount)
    return receipt !== null
  }
}`,
    keep: [
      'import',
      'export',
      'class',
      'async',
      'number',
      'Promise',
      'boolean',
      'const',
      'await',
      'return',
      'null',
      'this',
    ],
    mask: ['PaymentGateway', 'chargeCard', 'receipt', 'processor'],
  },
  python: {
    code: `from decimal import Decimal

class InvoiceService:
    def apply_discount(self, rate):
        if rate is None:
            raise ValueError("missing rate")
        return self.subtotal * (1 - rate)`,
    keep: [
      'from',
      'import',
      'class',
      'def',
      'self',
      'if',
      'is',
      'None',
      'raise',
      'ValueError',
      'return',
    ],
    mask: ['InvoiceService', 'apply_discount', 'subtotal'],
  },
  go: {
    code: `package billing

import "fmt"

type Invoice struct { Total float64 }

func (i *Invoice) Apply(rate float64) error {
	if rate < 0 {
		return fmt.Errorf("bad rate")
	}
	i.Total = i.Total * (1 - rate)
	return nil
}`,
    keep: [
      'package',
      'import',
      'type',
      'struct',
      'float64',
      'func',
      'error',
      'if',
      'return',
      'nil',
      'fmt',
      'Errorf',
    ],
    mask: ['Invoice', 'Total', 'Apply'],
  },
  java: {
    code: `import java.util.List;

public class OrderProcessor {
    @Override
    public void settleBatch(List<Order> pending) {
        System.out.println(pending.size());
    }
}`,
    keep: ['import', 'public', 'class', 'void', 'List', 'System', 'Override'],
    mask: ['OrderProcessor', 'settleBatch', 'pending'],
  },
  csharp: {
    code: `using System;

namespace Acme.Billing
{
    public class LedgerWriter
    {
        public string TenantSlug { get; set; }
        public void Flush() => Console.WriteLine(TenantSlug);
    }
}`,
    keep: [
      'using',
      'System',
      'namespace',
      'public',
      'class',
      'string',
      'void',
      'Console',
      'get',
      'set',
    ],
    mask: ['LedgerWriter', 'TenantSlug', 'Flush'],
  },
  rust: {
    code: `use crate::billing::Invoice;

pub fn apply_discount(invoice: &mut Invoice, rate: f64) -> Result<(), BillingError> {
    let mut total = invoice.subtotal;
    total *= 1.0 - rate;
    Ok(())
}`,
    keep: ['use', 'crate', 'pub', 'fn', 'mut', 'f64', 'Result', 'Ok', 'let'],
    mask: ['apply_discount', 'BillingError', 'subtotal'],
  },
  ruby: {
    code: `require 'json'

class InvoiceService
  attr_reader :subtotal

  def apply_discount(rate)
    raise ArgumentError, 'nope' if rate.nil?
    @subtotal * (1 - rate)
  end
end`,
    keep: ['require', 'class', 'attr_reader', 'def', 'raise', 'if', 'end', 'nil?'],
    mask: ['InvoiceService', 'apply_discount', 'subtotal'],
  },
  php: {
    code: `<?php
namespace Acme\\Billing;

class InvoiceService {
    public function applyDiscount(float $rate): float {
        if ($rate < 0) { throw new InvalidArgumentException('nope'); }
        return $this->subtotal * (1 - $rate);
    }
}`,
    keep: ['namespace', 'class', 'public', 'function', 'float', 'if', 'throw', 'new', 'return'],
    mask: ['InvoiceService', 'applyDiscount', 'subtotal'],
  },
  c: {
    code: `#include <stdio.h>
#include <stdlib.h>

typedef struct { double total; } Invoice;

int apply_discount(Invoice *inv, double rate) {
    if (rate < 0) { return -1; }
    inv->total *= (1 - rate);
    printf("%f", inv->total);
    return 0;
}`,
    keep: ['include', 'typedef', 'struct', 'double', 'int', 'if', 'return', 'printf'],
    mask: ['Invoice', 'apply_discount'],
  },
  sql: {
    code: `SELECT tenant_slug, SUM(net_amount) AS revenue
FROM billing_invoices
INNER JOIN customer_accounts ON customer_accounts.id = billing_invoices.account_id
WHERE settled_at IS NOT NULL
GROUP BY tenant_slug
ORDER BY revenue DESC;`,
    keep: [
      'SELECT',
      'SUM',
      'AS',
      'FROM',
      'INNER',
      'JOIN',
      'ON',
      'WHERE',
      'IS',
      'NOT',
      'NULL',
      'GROUP',
      'BY',
      'ORDER',
      'DESC',
    ],
    mask: ['tenant_slug', 'billing_invoices', 'customer_accounts', 'settled_at'],
  },
}

describe('detectLanguage', () => {
  for (const language of LANGUAGES) {
    it(`identifies ${language} from a representative sample`, () => {
      expect(detectLanguage(SAMPLES[language].code)).toBe(language)
    })
  }

  it('falls back to TypeScript on input with no language markers', () => {
    const guess = guessLanguage('alpha beta gamma delta')
    expect(guess.language).toBe('typescript')
    expect(guess.score).toBe(0)
    expect(guess.fallback).toBe(true)
  })

  it('falls back to TypeScript on empty input', () => {
    expect(guessLanguage('').fallback).toBe(true)
  })

  it('reports a non-zero score and no fallback for real code', () => {
    const guess = guessLanguage(SAMPLES.go.code)
    expect(guess.score).toBeGreaterThan(0)
    expect(guess.fallback).toBe(false)
  })

  it('caps any single marker so one repeated token cannot dominate', () => {
    // 200 bare `self` references are Python-flavoured but carry no structure.
    // Capped scoring keeps them from outvoting a genuinely Go file.
    const spam = 'self '.repeat(200)
    expect(detectLanguage(SAMPLES.go.code + '\n' + spam)).toBe('go')
  })
})

describe('resolveLanguage', () => {
  it('detects when the option is undefined', () => {
    expect(resolveLanguage(SAMPLES.rust.code, undefined)).toBe('rust')
  })

  it('detects when the option is auto', () => {
    expect(resolveLanguage(SAMPLES.rust.code, 'auto')).toBe('rust')
  })

  it('honours an explicit override over detection', () => {
    expect(resolveLanguage(SAMPLES.rust.code, 'python')).toBe('python')
  })
})

describe('keyword sets', () => {
  it('exposes a label for every language', () => {
    for (const language of LANGUAGES) {
      expect(LANGUAGE_LABELS[language]).toBeTruthy()
    }
  })

  it('includes the COMMON set in every language', () => {
    for (const language of LANGUAGES) {
      expect(isKeyword('idx', language)).toBe(true)
      expect(isKeyword('forEach', language)).toBe(true)
    }
  })

  it('caches the set so repeated calls return the same instance', () => {
    expect(keywordsFor('go')).toBe(keywordsFor('go'))
    expect(classKeywordsFor('rust')).toBe(classKeywordsFor('rust'))
    expect(fnKeywordsFor('rust')).toBe(fnKeywordsFor('rust'))
  })

  it('matches SQL keywords case-insensitively', () => {
    expect(isKeyword('SELECT', 'sql')).toBe(true)
    expect(isKeyword('select', 'sql')).toBe(true)
    expect(isKeyword('SeLeCt', 'sql')).toBe(true)
  })

  it('does not case-fold keywords in case-sensitive languages', () => {
    expect(isKeyword('FUNC', 'go')).toBe(false)
    expect(isKeyword('func', 'go')).toBe(true)
  })

  it('does not leak one language’s keywords into another', () => {
    expect(isKeyword('func', 'python')).toBe(false)
    expect(isKeyword('elif', 'go')).toBe(false)
    expect(isKeyword('attr_reader', 'typescript')).toBe(false)
  })

  it('extends class and function hints per language', () => {
    expect(classKeywordsFor('rust').has('impl')).toBe(true)
    expect(classKeywordsFor('typescript').has('impl')).toBe(false)
    expect(fnKeywordsFor('go').has('func')).toBe(true)
    expect(fnKeywordsFor('typescript').has('func')).toBe(false)
  })
})

describe('anonymize — per-language masking', () => {
  for (const language of LANGUAGES) {
    const { code, keep, mask } = SAMPLES[language]

    it(`keeps ${language} reserved words and built-ins intact`, () => {
      const { anonymized } = anonymize(code, { language })
      for (const word of keep) {
        expect(
          new RegExp(`(?<![a-zA-Z0-9_$])${word}(?![a-zA-Z0-9_$])`).test(anonymized),
          `${language}: expected "${word}" to survive masking`
        ).toBe(true)
      }
    })

    it(`masks ${language} proprietary identifiers`, () => {
      const { anonymized, map } = anonymize(code, { language })
      for (const word of mask) {
        expect(anonymized.includes(word), `${language}: expected "${word}" to be masked`).toBe(
          false
        )
        expect(Object.values(map)).toContain(word)
      }
    })

    it(`round-trips ${language} exactly`, () => {
      const { anonymized, map } = anonymize(code, { language })
      expect(restore(anonymized, map).restored).toBe(code)
    })

    it(`reports the resolved language for ${language}`, () => {
      expect(anonymize(code, { language }).language).toBe(language)
    })

    it(`auto-detects ${language} without an explicit option`, () => {
      expect(anonymize(code).language).toBe(language)
    })
  }
})

describe('comment syntax per language', () => {
  it('leaves Python # comments as prose', () => {
    const code = '# Reconcile the ledger against the settlement file.\nvalue = 1'
    const { anonymized } = anonymize(code, { language: 'python' })
    expect(anonymized).toContain('# Reconcile the ledger against the settlement file.')
  })

  it('leaves Python docstrings as prose', () => {
    const code = 'def f():\n    """Reconciles the ledger for a tenant."""\n    return 1'
    const { anonymized } = anonymize(code, { language: 'python' })
    expect(anonymized).toContain('"""Reconciles the ledger for a tenant."""')
  })

  it('handles a single-quoted Python docstring', () => {
    const code = "def f():\n    '''Reconciles the ledger.'''\n    return 1"
    const { anonymized } = anonymize(code, { language: 'python' })
    expect(anonymized).toContain("'''Reconciles the ledger.'''")
  })

  it('handles an unterminated docstring without hanging', () => {
    const { anonymized } = anonymize('"""dangling prose about ledgers', { language: 'python' })
    expect(anonymized).toContain('dangling prose about ledgers')
  })

  it('leaves Ruby # comments as prose', () => {
    const code = '# Settles the outstanding balance.\nvalue = 1'
    expect(anonymize(code, { language: 'ruby' }).anonymized).toContain(
      '# Settles the outstanding balance.'
    )
  })

  it('leaves Ruby =begin/=end blocks as prose', () => {
    const code = '=begin\nReconciles the tenant ledger.\n=end\nvalue = 1'
    expect(anonymize(code, { language: 'ruby' }).anonymized).toContain(
      'Reconciles the tenant ledger.'
    )
  })

  it('handles an unterminated Ruby block comment', () => {
    const { anonymized } = anonymize('=begin\ndangling ledger prose', { language: 'ruby' })
    expect(anonymized).toContain('dangling ledger prose')
  })

  it('leaves SQL -- comments as prose', () => {
    const code = '-- Aggregate revenue per tenant.\nSELECT 1;'
    expect(anonymize(code, { language: 'sql' }).anonymized).toContain(
      '-- Aggregate revenue per tenant.'
    )
  })

  it('treats PHP # and // comments as prose', () => {
    const code = '<?php\n# Settles the balance.\n// Also settles the balance.\n$x = 1;'
    const { anonymized } = anonymize(code, { language: 'php' })
    expect(anonymized).toContain('# Settles the balance.')
    expect(anonymized).toContain('// Also settles the balance.')
  })

  it('does NOT treat # as a comment in C-style languages', () => {
    // `#include` is a directive, not prose — its identifiers stay maskable.
    const { anonymized } = anonymize('#include "ledger_internal.h"', { language: 'c' })
    expect(anonymized).not.toContain('ledger_internal')
  })

  it('exposes comment syntax for every language', () => {
    for (const language of LANGUAGES) {
      const syntax = commentSyntaxFor(language)
      expect(syntax.quotes.length).toBeGreaterThan(0)
    }
  })

  it('does not treat backticks as strings in Python', () => {
    // Python has no backtick literal; treating one as a quote would swallow
    // the rest of the file into a single unmaskable segment.
    const { anonymized } = anonymize('value = 1 # ` stray backtick\nledgerTotal = 2', {
      language: 'python',
    })
    expect(anonymized).not.toContain('ledgerTotal')
  })
})

describe('string-literal scanning', () => {
  it('does not end a string at an escaped quote', () => {
    // If the escape were ignored, the literal would close early and the trailing
    // code would be re-scanned as if it were inside a string.
    const code = 'const note = "she said \\"ship it\\" today"\nconst ledgerTotal = 1'
    const { anonymized, map } = anonymize(code)
    expect(Object.values(map)).toContain('ledgerTotal')
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('handles a string terminated by end-of-input after a backslash', () => {
    const code = 'const note = "trailing\\'
    expect(() => anonymize(code)).not.toThrow()
  })

  it('handles an unterminated string literal', () => {
    const code = 'const note = "never closed'
    expect(() => anonymize(code)).not.toThrow()
  })
})

describe('language-aware helpers', () => {
  it('extractIdentifiers honours the language keyword set', () => {
    const code = 'func settleLedger() error { return nil }'
    expect(extractIdentifiers(code, 'go')).not.toContain('func')
    expect(extractIdentifiers(code, 'go')).toContain('settleLedger')
    // Under the TypeScript default, `func` is not a keyword and gets extracted.
    expect(extractIdentifiers(code)).toContain('func')
  })

  it('classifyIdentifiers uses per-language function hints', () => {
    expect(classifyIdentifiers('func settleLedger() {}', 'go').settleLedger).toBe('function')
    expect(classifyIdentifiers('fn settleLedger() {}', 'rust').settleLedger).toBe('function')
  })

  it('classifyIdentifiers uses per-language class hints', () => {
    expect(classifyIdentifiers('type LedgerEntry struct {}', 'go').LedgerEntry).toBe('class')
    expect(classifyIdentifiers('impl LedgerEntry {}', 'rust').LedgerEntry).toBe('class')
  })

  it('defaults both helpers to TypeScript', () => {
    expect(extractIdentifiers('const ledgerTotal = 1')).toContain('ledgerTotal')
    expect(classifyIdentifiers('class LedgerEntry {}').LedgerEntry).toBe('class')
  })
})

describe('regression — TypeScript behaviour is unchanged', () => {
  it('produces identical output whether TypeScript is detected or forced', () => {
    const code = SAMPLES.typescript.code
    expect(anonymize(code).anonymized).toBe(anonymize(code, { language: 'typescript' }).anonymized)
  })

  it('still recognises an options object that only sets language', () => {
    // isAnonymizeOptions must not mistake { language: 'go' } for a SymbolMap:
    // every value is a string, so the legacy positional check would misread it.
    const result = anonymize('func settleLedger() {}', { language: 'go' })
    expect(result.language).toBe('go')
    expect(Object.values(result.map)).not.toContain('go')
  })
})
