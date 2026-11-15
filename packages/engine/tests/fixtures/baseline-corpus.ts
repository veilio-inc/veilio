// The frozen corpus behind baseline-1.19.2.json: what the published engine
// 1.19.2 answered for each row and option set is recorded there, once, and
// baseline-1.19.2.test.ts holds every later build to it, row by row. A row
// that may differ is listed in baseline-exceptions.ts with the reason.
//
// Never edit a row: its recorded answer would no longer be the published
// engine's. A new row needs its own record, taken from 1.19.2 again.
//
// No imports that run: baseline-1.19.2.gen.mjs loads this file with Node
// alone, and hands in the rows of the other fixtures.
import type { AnonymizeOptions } from '../../src/types.js'
import type { SyntaxCase } from './syntax-corpus.js'
import type { Row as MarkRow } from './manual-marks.js'

export interface BaselineRow {
  name: string
  code: string
  options: AnonymizeOptions[]
  /** Names planted in the text: none may be readable where a fix applies. */
  names?: string[]
  /** Credential text planted in the row, piece by piece. */
  secrets?: string[]
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Made-up text of `length` characters: the same for the same seed. Every
 *  credential-shaped value here is built at run time, never written whole. */
function made(seed: number, length: number, alphabet = BASE62): string {
  let s = seed * 2654435761 + 1
  let out = ''
  for (let i = 0; i < length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out += alphabet[(s >>> 0) % alphabet.length]
  }
  return out
}

const GH_BODY = made(11, 36)
const GH = 'gh' + 'p_' + GH_BODY
const STRIPE_BODY = made(12, 24)
const SLACK_BODY = made(13, 12, '0123456789') + '-' + made(14, 24)
const SLACK = 'xo' + 'xb-' + SLACK_BODY
const URL_KEY = made(15, 28)
const DSN_PASSWORD = made(16, 6) + '?' + made(17, 5) + '#' + made(18, 6)
const KEY_LINES = Array.from({ length: 4 }, (_, i) => made(20 + i, 64))
const KEY_TAIL = made(30, 12)
const HEX_LINE = made(31, 64, '0123456789abcdef')
const LONG_LINES = Array.from({ length: 190 }, (_, i) => made(100 + i, 64))
const SECRET_BODY = made(40, 52)
const SECRET_VALUE = SECRET_BODY + '=='
const SECRET_TEXT = made(41, 20)
const BEGIN = '-----BEGIN PRIVATE KEY-----'
const END = '-----END PRIVATE KEY-----'
const BEGIN_SSH = '-----BEGIN OPENSSH PRIVATE KEY-----'
const END_SSH = '-----END OPENSSH PRIVATE KEY-----'
const PEM = [BEGIN, ...KEY_LINES, END].join('\n')

const NAMES = [
  'AcmePay',
  'AcmeLedger',
  'settleInvoice',
  'customerTotal',
  'acme_refunds',
  'acme_corp',
  'acmeCorp',
]

// ─── One sample per language ────────────────────────────────────────────────

const TYPESCRIPT = `// Ledger client for the billing service.
import { PaymentGateway } from './gateway'
import type { Invoice } from "./types"

/* Settles invoices in batches. */
export class AcmeLedger {
  private readonly gateway: PaymentGateway
  private customerTotal = 0

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway
  }

  /** Sends one invoice to the gateway. */
  async settleInvoice(invoice: Invoice, retries = 3): Promise<boolean> {
    const endpoint = "https://billing.example.com/v2/settle?mode=fast&api_key=${URL_KEY}#top"
    const pattern = /\\/*[a-z]+$/
    const glob = 'build/*.js'
    const label = \`invoice \${invoice.id} of \${this.customerTotal}\`
    if (pattern.test(label)) return false
    const response = await this.gateway.send(endpoint, { label, glob, retries })
    this.customerTotal += response.amount // running total
    return response.ok
  }
}

const dsn = "Server=db.example.com;Database=ledger;User Id=svc;Password=${DSN_PASSWORD};"
const token = "${GH}"
const pem = \`${PEM}\`

export function acmeRefunds(ledger: AcmeLedger, acmeCorp: string): number {
  return ledger && acmeCorp ? 1 : 0
}
`

const PYTHON = `"""Ledger client for the billing service.

Settles invoices through the PaymentGateway.
"""
import os
from gateway import PaymentGateway

# The default number of retries.
RETRIES = 3


class AcmeLedger:
    """Keeps the running total of one customer."""

    def __init__(self, gateway: PaymentGateway):
        self.gateway = gateway
        self.customer_total = 0

    def settle_invoice(
        self,
        invoice,
        retries=RETRIES,
    ):
        """Send one invoice to the gateway."""
        endpoint = "https://billing.example.com/v2/settle?mode=fast&api_key=${URL_KEY}"
        label = f"invoice {invoice.id} of {self.customer_total}"
        glob = 'build/*.py'
        response = self.gateway.send(endpoint, label, glob, retries)
        self.customer_total += response.amount  # running total
        return response.ok


def acme_refunds(ledger): """One line of documentation."""


def open_ledger(acme_corp):
    password = "${DSN_PASSWORD}"
    return AcmeLedger(PaymentGateway(acme_corp, os.environ.get("HOME"), password))
`

const GO = `// Package ledger settles invoices.
package ledger

import (
	"fmt"
	"net/http"
)

/* AcmeLedger keeps the running total of one customer. */
type AcmeLedger struct {
	gateway       *PaymentGateway
	customerTotal int
}

// SettleInvoice sends one invoice to the gateway.
func (l *AcmeLedger) SettleInvoice(invoiceID string, retries int) (bool, error) {
	endpoint := "https://billing.example.com/v2/settle?mode=fast&token=${URL_KEY}"
	glob := \`build/*.go\`
	label := fmt.Sprintf("invoice %s of %d", invoiceID, l.customerTotal)
	response, err := http.Get(endpoint + label + glob)
	if err != nil {
		return false, err
	}
	l.customerTotal += retries // running total
	return response.StatusCode == 200, nil
}

func acmeRefunds(ledger *AcmeLedger, acmeCorp rune) int {
	separator := '/'
	if ledger != nil && acmeCorp == separator {
		return 1
	}
	return 0
}
`

const JAVA = `// Ledger client for the billing service.
package com.example.ledger;

import java.util.List;

/**
 * Keeps the running total of one customer.
 */
public class AcmeLedger {
    private final PaymentGateway gateway;
    private int customerTotal = 0;

    public AcmeLedger(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    /* Sends one invoice to the gateway. */
    public boolean settleInvoice(String invoiceId, int retries) {
        String endpoint = "https://billing.example.com/v2/settle?mode=fast&secret=${URL_KEY}";
        String glob = "build/*.jar";
        char separator = '/';
        String query = """
            SELECT refund_total, invoice_owner
            FROM ledger_entries
            WHERE invoice_id = ?
            """;
        Response response = gateway.send(endpoint, query, glob, separator, retries);
        customerTotal += response.amount(); // running total
        return response.ok();
    }

    static int acmeRefunds(List<AcmeLedger> ledgers, String acmeCorp) {
        return ledgers.isEmpty() || acmeCorp == null ? 0 : 1;
    }
}
`

const CSHARP = `// Ledger client for the billing service.
using System;
using System.Collections.Generic;

namespace Example.Ledger
{
    /// <summary>Keeps the running total of one customer.</summary>
    public class AcmeLedger
    {
        private readonly PaymentGateway gateway;
        private int customerTotal = 0;

        public AcmeLedger(PaymentGateway gateway)
        {
            this.gateway = gateway;
        }

        /* Sends one invoice to the gateway. */
        public bool SettleInvoice(string invoiceId, int retries)
        {
            var endpoint = "https://billing.example.com/v2/settle?mode=fast&password=${URL_KEY}";
            var glob = @"build\\*.dll";
            var separator = '/';
            var label = $"invoice {invoiceId} of {customerTotal}";
            var response = gateway.Send(endpoint, label, glob, separator, retries);
            customerTotal += response.Amount; // running total
            return response.Ok;
        }

        static int AcmeRefunds(List<AcmeLedger> ledgers, string acmeCorp)
        {
            return ledgers.Count == 0 || acmeCorp == null ? 0 : 1;
        }
    }
}
`

const RUST = `// Ledger client for the billing service.
use std::collections::HashMap;

/* Keeps the running total of one customer. */
pub struct AcmeLedger {
    gateway: PaymentGateway,
    customer_total: u64,
}

impl AcmeLedger {
    /// Sends one invoice to the gateway.
    pub fn settle_invoice(&mut self, invoice_id: &str, retries: u32) -> Result<bool, String> {
        let endpoint = "https://billing.example.com/v2/settle?mode=fast&access_token=${URL_KEY}";
        let glob = "build/*.rlib";
        let separator = '/';
        let label = format!("invoice {} of {}", invoice_id, self.customer_total);
        let response = self.gateway.send(endpoint, &label, glob, separator, retries)?;
        self.customer_total += response.amount; // running total
        Ok(response.ok)
    }
}

fn acme_refunds(ledgers: &HashMap<String, AcmeLedger>, acme_corp: &str) -> usize {
    if ledgers.is_empty() || acme_corp.is_empty() {
        0
    } else {
        1
    }
}
`

const RUBY = `# Ledger client for the billing service.
require 'net/http'

=begin
Keeps the running total of one customer.
=end
class AcmeLedger
  attr_reader :customer_total

  def initialize(gateway)
    @gateway = gateway
    @customer_total = 0
  end

  # Sends one invoice to the gateway.
  def settle_invoice(invoice_id, retries = 3)
    endpoint = "https://billing.example.com/v2/settle?mode=fast&key=${URL_KEY}"
    glob = 'build/*.rb'
    label = "invoice #{invoice_id} of #{@customer_total}"
    response = @gateway.send_request(endpoint, label, glob, retries)
    @customer_total += response.amount # running total
    response.ok?
  end
end

def acme_refunds(ledgers, acme_corp)
  return 0 if ledgers.empty? || acme_corp.nil?

  1
end
`

const PHP = `<?php
// Ledger client for the billing service.
namespace Example\\Ledger;

use Example\\Gateway\\PaymentGateway;

/* Keeps the running total of one customer. */
class AcmeLedger
{
    private PaymentGateway $gateway;
    private int $customerTotal = 0;

    public function __construct(PaymentGateway $gateway)
    {
        $this->gateway = $gateway;
    }

    # Sends one invoice to the gateway.
    public function settleInvoice(string $invoiceId, int $retries = 3): bool
    {
        $endpoint = "https://billing.example.com/v2/settle?mode=fast&api_key=${URL_KEY}";
        $glob = 'build/*.php';
        $label = "invoice {$invoiceId} of {$this->customerTotal}";
        $response = $this->gateway->send($endpoint, $label, $glob, $retries);
        $this->customerTotal += $response->amount; // running total
        return $response->ok;
    }
}

function acmeRefunds(array $ledgers, ?string $acmeCorp): int
{
    return count($ledgers) === 0 || $acmeCorp === null ? 0 : 1;
}
`

const C = `

#include <stdio.h>
#include "gateway.h"

#define RETRIES 3

/* Keeps the running total of one customer. */
typedef struct {
    PaymentGateway *gateway;
    int customer_total;
} AcmeLedger;

// Sends one invoice to the gateway.
int settle_invoice(AcmeLedger *ledger, const char *invoice_id, int retries) {
    const char *endpoint = "https://billing.example.com/v2/settle?mode=fast&token=${URL_KEY}";
    const char *glob = "build/*.o";
    char separator = '/';
    char label[64];
    snprintf(label, sizeof label, "invoice %s of %d", invoice_id, ledger->customer_total);
    int amount = gateway_send(ledger->gateway, endpoint, label, glob, separator, retries);
    ledger->customer_total += amount; // running total
    return amount > 0;
}

int acme_refunds(const AcmeLedger *ledger, const char *acme_corp) {
    return ledger != NULL && acme_corp != NULL ? RETRIES : 0;
}
`

const SQL = `-- Ledger tables for the billing service.
CREATE TABLE ledger_entries (
    invoice_id INTEGER PRIMARY KEY,
    invoice_owner VARCHAR(64) NOT NULL,
    refund_total DECIMAL(12, 2) DEFAULT 0
);

/* The running total of one customer. */
CREATE VIEW customer_totals AS
SELECT invoice_owner, SUM(refund_total) AS customer_total
FROM ledger_entries
WHERE invoice_owner <> 'AcmePay' -- the house account
GROUP BY invoice_owner;

INSERT INTO ledger_entries (invoice_id, invoice_owner, refund_total)
VALUES (1, 'PaymentGateway', 12.50), (2, "AcmeLedger", 0);

SELECT acme_refunds, customerTotal
FROM acme_corp.settle_invoice
WHERE path LIKE 'build/*' AND note = 'It''s settled';
`

// ─── One sample per file kind ───────────────────────────────────────────────

const SHELL = `#!/bin/bash
# Deploys the ledger service.
set -euo pipefail

TARGET_DIR="/srv/ledger"
export DB_PASSWORD=${DSN_PASSWORD}

deploy_ledger() {
  local release_tag=$1
  mkdir -p "$TARGET_DIR/$release_tag"
  cp build/ledger.tar "$TARGET_DIR/$release_tag/"
  echo 'deployed' "$release_tag"
}

settle_invoice() {
  curl -s "https://billing.example.com/v2/settle?mode=fast&api_key=${URL_KEY}"
}

deploy_ledger "$1" && settle_invoice
`

const DOCKERFILE = `# Image of the ledger service.
FROM node:24-slim AS build
WORKDIR /srv/ledger
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV LEDGER_MODE=production
ENV DB_PASSWORD ${DSN_PASSWORD}
COPY --from=build /srv/ledger/dist ./dist
CMD ["node", "dist/acmeLedger.js", "--settle-invoice"]
`

const YAML = `# Pipeline of the ledger service.
name: ledger
on:
  push:
    branches: [main]
env:
  LEDGER_MODE: production
  API_TOKEN: ${URL_KEY}
jobs:
  settle_invoice:
    runs-on: ubuntu-latest
    steps:
      - name: Build AcmeLedger
        run: npm run build
      - name: Deploy
        run: ./deploy.sh "customer total"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ledger-config
data:
  ledgerMode: production
  gatewayUrl: https://billing.example.com/v2
`

const DOTENV = `# Settings of the ledger service.
LEDGER_MODE=production
GATEWAY_URL=https://billing.example.com/v2
DB_PASSWORD=${DSN_PASSWORD}
API_TOKEN="${URL_KEY}"
CUSTOMER_TOTAL_LIMIT=5000
export ACME_LEDGER_NAME='AcmeLedger'
`

const INI = `; Settings of the ledger service.
[ledger]
mode = production
gateway_url = https://billing.example.com/v2
customer_total_limit = 5000

[database]
host = db.example.com
user = svc
password = ${DSN_PASSWORD}
# The name the gateway knows us by.
client_name = AcmeLedger
`

const MARKDOWN = `# Ledger service

The service settles invoices through the PaymentGateway.

## Running

\`\`\`bash
npm run build
node dist/acmeLedger.js --settle-invoice
\`\`\`

Set \`DB_PASSWORD=${DSN_PASSWORD}\` first. The class AcmeLedger keeps the
customerTotal of one customer; see https://billing.example.com/docs.
`

const MAKEFILE = `# Builds the ledger service.
BUILD_DIR := build
SOURCES := $(wildcard src/*.c)
DB_PASSWORD = ${DSN_PASSWORD}

.PHONY: all clean

all: $(BUILD_DIR)/acme_ledger

$(BUILD_DIR)/acme_ledger: $(SOURCES)
\tmkdir -p $(BUILD_DIR)
\t$(CC) -o $@ $^

clean:
\trm -rf $(BUILD_DIR)
`

const LANGUAGES: [NonNullable<AnonymizeOptions['language']>, string][] = [
  ['typescript', TYPESCRIPT],
  ['python', PYTHON],
  ['go', GO],
  ['java', JAVA],
  ['csharp', CSHARP],
  ['rust', RUST],
  ['ruby', RUBY],
  ['php', PHP],
  ['c', C],
  ['sql', SQL],
]

const KINDS: [string, NonNullable<AnonymizeOptions['fileKind']>, string][] = [
  ['deploy.sh', 'shell', SHELL],
  ['Dockerfile', 'shell', DOCKERFILE],
  ['ci.yml', 'yaml', YAML],
  ['.env', 'dotenv', DOTENV],
  ['app.ini', 'ini', INI],
  ['README.md', 'text', MARKDOWN],
  ['Makefile', 'text', MAKEFILE],
]

const crlf = (text: string): string => text.replace(/\n/g, '\r\n')

const samples: BaselineRow[] = [
  ...LANGUAGES.map(([language, code]) => ({
    name: `sample: ${language}`,
    code,
    options: [{ language }, {}],
    secrets: [URL_KEY, DSN_PASSWORD, GH, ...KEY_LINES],
  })),
  ...KINDS.map(([path, fileKind, code]) => ({
    name: `sample: ${path}`,
    code,
    options: [{ path }, { fileKind }, {}],
    secrets: [URL_KEY, DSN_PASSWORD],
  })),
  {
    name: 'sample: typescript, CRLF',
    code: crlf(TYPESCRIPT),
    options: [{ language: 'typescript' }, {}],
    secrets: [URL_KEY, DSN_PASSWORD, GH, ...KEY_LINES],
  },
  {
    name: 'sample: python, CRLF',
    code: crlf(PYTHON),
    options: [{ language: 'python' }, {}],
    secrets: [URL_KEY, DSN_PASSWORD],
  },
]

// ─── The inputs a fix may change, and the ones beside them it must not ──────

const python = (name: string, code: string): BaselineRow => ({
  name,
  code,
  options: [{ language: 'python' }, {}],
  names: NAMES,
})

const tripleQuoted: BaselineRow[] = [
  python(
    'python: an assigned triple-quoted query',
    `query = """
    SELECT acme_refunds, customerTotal FROM acme_corp.AcmeLedger WHERE owner = 'AcmePay'
"""
`
  ),
  python(
    'python: a triple-quoted f-string',
    'def go(acmeCorp):\n    return f"""{acmeCorp.acme_refunds} {AcmePay}"""\n'
  ),
  python(
    'python: a triple-quoted call argument',
    "log.info('''AcmePay settleInvoice failed for acme_refunds''', x)\n"
  ),
  python('python: a triple-quoted dictionary value', 'd = {"k": """acme_corp"""}\n'),
  python(
    'python: a triple-quoted argument on its own line',
    'cursor.execute(\n    """\n    UPDATE acme_corp.AcmeLedger SET customerTotal = 0\n    """,\n    params,\n)\n'
  ),
  python(
    'python: a triple-quoted dictionary value on its own line',
    'QUERIES = {\n    "refunds":\n        """SELECT acme_refunds FROM acme_corp""",\n}\n'
  ),
  python(
    'python: a triple-quoted returned value',
    'def query():\n    return """SELECT customerTotal FROM acme_corp.AcmeLedger"""\n'
  ),
  ...['f', 'r', 'b', 'u', 'rb', 'F', 'R', 'Rb'].map((prefix) =>
    python(
      `python: a triple-quoted literal with the prefix ${prefix}`,
      `text = ${prefix}"""AcmePay settleInvoice for acme_refunds"""\n`
    )
  ),
  python(
    'python: the same words in a single-quoted string',
    'text = "AcmePay settleInvoice for acme_refunds"\n'
  ),
  python(
    'python: a raw docstring',
    'def settleInvoice():\n    r"""Settles for AcmePay with \\d digits."""\n    return 1\n'
  ),
  python(
    'python: a literal after a class attribute',
    'class AcmeLedger:\n    limit = 5\n    """The customerTotal limit of acme_corp."""\n'
  ),
  python(
    'python: a bare literal under if',
    'if ready:\n    """AcmePay settleInvoice for acme_refunds"""\n    run()\n'
  ),
  python(
    'python: a second bare literal after the docstring',
    '"""Module of the ledger."""\n"""AcmePay settleInvoice for acme_refunds"""\nimport os\n'
  ),
  python(
    'python: a triple-quoted literal never closed',
    'query = """\n    SELECT acme_refunds FROM acme_corp.AcmeLedger\nimport os\n'
  ),
  python(
    'python: a fragment that starts with a triple quote',
    '"""\ncustomerTotal = settleInvoice(acme_refunds)\n"""\nimport os\n'
  ),
  // Real docstrings: these stay as they are.
  python(
    'python: module, class and function docstrings',
    `"""Ledger module.

Talks to the PaymentGateway.
"""


class Ledger:
    '''Keeps one total.'''

    def settle(self, invoice):
        """Send one invoice."""
        return invoice
`
  ),
  python(
    'python: a docstring on the header line',
    'def settle(invoice): """Send one invoice."""\n'
  ),
  python(
    'python: a docstring after a header over several lines',
    'async def settle(\n    invoice,\n    retries=3,\n) -> dict[str, int]:\n    """Send one invoice."""\n    return {}\n'
  ),
  python(
    'python: a docstring followed by a comment',
    'def settle(invoice):\n    """Send one invoice."""  # short\n    return invoice\n'
  ),
  python(
    'python: a credential inside a triple-quoted literal',
    `text = f"""token ${GH} for {acmeCorp}"""\n`
  ),
].map((row) => ({ ...row, secrets: [GH] }))

const SHELL_ONE = `#!/bin/bash
function deploy() {
  local target=$1
  rm -rf build/*
  acme_refunds=1
  settleInvoice "$acmeCorp"
}
export AcmePay
`
const SHELL_TWO = `set -e
rm -rf build/*
customerTotal=1
deploy_AcmePay() { settleInvoice "$acme_corp"; }
deploy_AcmePay
`
const DOCKER_GLOB = 'COPY packages/*/package.json ./\nRUN ./acme_refunds --AcmePay settleInvoice\n'
const YAML_GLOB = 'paths:\n  - src/**\njobs:\n  acme_refunds:\n    name: AcmePay settleInvoice\n'
const MAKE_GLOB = 'SOURCES := src/*.c\n\nacme_refunds: $(SOURCES)\n\t./settleInvoice --AcmePay\n'
const INI_GLOB = '[paths]\ninclude = src/*\nowner = AcmePay\ntask = settleInvoice\n'
const JSX =
  'export const Docs = () => <p>docs at /* not a comment</p>; const AcmePay = settleInvoice(acme_refunds);\n'

const byKind = (
  name: string,
  code: string,
  path: string,
  fileKind: NonNullable<AnonymizeOptions['fileKind']>
): BaselineRow => ({
  name,
  code,
  options: [{ fileKind }, { path }, {}, { fileKind, language: 'typescript' }],
  names: NAMES,
})

const commentOpeners: BaselineRow[] = [
  byKind('shell: a glob in a function', SHELL_ONE, 'd.sh', 'shell'),
  byKind('shell: a glob at the top level', SHELL_TWO, 'run.sh', 'shell'),
  byKind('Dockerfile: a glob in COPY', DOCKER_GLOB, 'Dockerfile', 'shell'),
  byKind('yaml: a glob in a list', YAML_GLOB, 'ci.yml', 'yaml'),
  byKind('Makefile: a glob in a variable', MAKE_GLOB, 'Makefile', 'text'),
  byKind('ini: a glob in a value', INI_GLOB, 'app.ini', 'ini'),
  {
    name: 'typescript: a block opener in JSX text',
    code: JSX,
    options: [{ language: 'typescript' }, {}],
    names: NAMES,
  },
  {
    name: 'typescript: closed comments',
    code: '/* AcmePay */ const customerTotal = 1 // settleInvoice\nconst glob = "src/*"; const re = /\\/*x/\n',
    options: [{ language: 'typescript' }, {}],
  },
]

const lineEnds: BaselineRow[] = [
  {
    name: 'typescript: a line comment before a lone CR',
    code: '// header\rclass AcmePay {\r  settleInvoice(acme_refunds) {}\r}\r',
    options: [{ language: 'typescript' }, {}],
    names: NAMES,
  },
  {
    name: 'python: a line comment before a lone CR',
    code: '# header\rclass AcmePay:\r    def settleInvoice(self, acme_refunds):\r        return acme_refunds\r',
    options: [{ language: 'python' }, {}],
    names: NAMES,
  },
  {
    name: 'typescript: a line comment before U+2028',
    code: '// header\u2028class AcmePay { settleInvoice(acme_refunds) {} }\n',
    options: [{ language: 'typescript' }, {}],
    names: NAMES,
  },
  {
    name: 'typescript: a line comment before U+2029',
    code: '// header\u2029class AcmePay { settleInvoice(acme_refunds) {} }\n',
    options: [{ language: 'typescript' }, {}],
    names: NAMES,
  },
  {
    name: 'typescript: mixed line endings',
    code: '// one\r\nconst customerTotal = 1 // two\rclass AcmePay {}\n// three\nconst acmeCorp = 2\r\n',
    options: [{ language: 'typescript' }, {}],
    names: NAMES,
  },
]

const CREDENTIAL_WORDS = ['api_key', 'access_token', 'token', 'secret', 'password', 'key']

const urlRow = (name: string, code: string, language: 'typescript' | 'python'): BaselineRow => ({
  name,
  code,
  options: [{ language }, {}],
  secrets: [URL_KEY, DSN_PASSWORD],
})

const urlParameters: BaselineRow[] = [
  ...CREDENTIAL_WORDS.flatMap((word) => [
    urlRow(
      `url: ${word} as the first parameter`,
      `const u = "https://api.example.com/v1?${word}=${URL_KEY}&x=1";\n`,
      'typescript'
    ),
    urlRow(
      `url: ${word} in the fragment`,
      `const u = "https://api.example.com/cb#${word}=${URL_KEY}";\n`,
      'typescript'
    ),
    // As 1.19.2 already reads them.
    urlRow(
      `url: ${word} as the second parameter`,
      `const u = "https://api.example.com/v1?x=1&${word}=${URL_KEY}";\n`,
      'typescript'
    ),
  ]),
  urlRow(
    'url: api_key first, in a template literal',
    `const u = \`https://api.example.com/v1?api_key=${URL_KEY}&x=\${page}\`;\n`,
    'typescript'
  ),
  urlRow(
    'url: key first, in Python',
    `requests.get("https://maps.example.com/api?key=${URL_KEY}")\n`,
    'python'
  ),
  urlRow(
    'url: access_token in the fragment, in Python',
    `callback = 'https://app.example.com/cb#access_token=${URL_KEY}'\n`,
    'python'
  ),
  urlRow(
    'url: a credential after a nested question mark',
    `const u = "https://app.example.com/go?next=/cb?token=${URL_KEY}";\n`,
    'typescript'
  ),
  // As 1.19.2 already reads them.
  urlRow(
    'url: the second parameter, with a fragment after it',
    `const u = "https://api.example.com/v1?x=1&api_key=${URL_KEY}#section";\n`,
    'typescript'
  ),
  urlRow('url: no scheme', `const u = "/v1?api_key=${URL_KEY}";\n`, 'typescript'),
  urlRow(
    'url: no credential word',
    'const u = "https://api.example.com/v1?page=2&sort=customerTotal#top";\n',
    'typescript'
  ),
  urlRow(
    'dsn: a password holding ? and #',
    `const dsn = "Server=db.example.com;Database=ledger;Password=${DSN_PASSWORD};";\n`,
    'typescript'
  ),
]

const keyRow = (name: string, code: string, secrets: string[]): BaselineRow => ({
  name,
  code,
  options: [{}, { fileKind: 'text' }],
  secrets,
})
const secretRow = (name: string, code: string): BaselineRow => ({
  name,
  code,
  options: [{ fileKind: 'yaml' }, { path: 'secret.yaml' }, {}],
  secrets: [SECRET_BODY, SECRET_TEXT, ...KEY_LINES],
})

const keyMaterial: BaselineRow[] = [
  keyRow(
    'key: BEGIN, two body lines, no END',
    `${BEGIN_SSH}\n${KEY_LINES[0]!.slice(0, 52)}\n${HEX_LINE}\n`,
    [KEY_LINES[0]!.slice(0, 52), HEX_LINE]
  ),
  keyRow('key: BEGIN with nothing after it', `${BEGIN_SSH}\n`, []),
  keyRow(
    'key: a body of 12,000 characters with END',
    `${BEGIN}\n${LONG_LINES.join('\n')}\n${END}\n`,
    LONG_LINES
  ),
  keyRow('key: a body of 12,000 characters, no END', `${BEGIN}\n${LONG_LINES.join('\n')}\n`, [
    ...LONG_LINES,
  ]),
  keyRow(
    'key: a short line after the body, no END',
    `${BEGIN}\n${KEY_LINES.join('\n')}\n${KEY_TAIL}\n\nexport LEDGER_MODE=production\n`,
    [...KEY_LINES, KEY_TAIL]
  ),
  keyRow(
    'key: PEM headers, no END',
    `${BEGIN.replace('PRIVATE', 'RSA PRIVATE')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${HEX_LINE.slice(0, 32)}\n\n${KEY_LINES.join('\n')}\n`,
    [...KEY_LINES, HEX_LINE.slice(0, 32)]
  ),
  // As 1.19.2 already reads it.
  keyRow('key: a complete block', `${PEM}\nexport LEDGER_MODE=production\n`, KEY_LINES),
  keyRow(
    'key: a complete OpenSSH block in a heredoc',
    `cat > id_ledger <<EOF\n${BEGIN_SSH}\n${KEY_LINES.join('\n')}\n${END_SSH}\nEOF\n`,
    KEY_LINES
  ),
  secretRow(
    'secret manifest: data',
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ledger\ndata:\n  db: ${SECRET_VALUE}\n`
  ),
  secretRow(
    'secret manifest: stringData with a block scalar',
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ledger\nstringData:\n  note: ${SECRET_TEXT}\n  id_ledger: |\n    ${KEY_LINES[0]}\n    ${KEY_LINES[1]}\ntype: Opaque\n`
  ),
  secretRow(
    'secret manifest: one of three documents',
    `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ledger-config\ndata:\n  ledgerMode: production\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: ledger\ndata:\n  db: ${SECRET_VALUE}\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: ledger\n`
  ),
  secretRow(
    'secret manifest: inside a List',
    `apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: ConfigMap\n    data:\n      ledgerMode: production\n  - apiVersion: v1\n    kind: Secret\n    data:\n      db: ${SECRET_VALUE}\n`
  ),
  // As 1.19.2 already reads it.
  secretRow(
    'manifest: a ConfigMap',
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ledger-config\ndata:\n  ledgerMode: production\n  gatewayName: AcmeLedger\n'
  ),
]

const pieces = (text: string, count: number): string[] => {
  const size = Math.floor(text.length / count)
  return Array.from({ length: count }, (_, i) =>
    text.slice(i * size, i === count - 1 ? text.length : (i + 1) * size)
  )
}
const joined = (parts: string[], by: string): string => parts.map((p) => `"${p}"`).join(by)

const splitRow = (
  name: string,
  code: string,
  language: NonNullable<AnonymizeOptions['language']>,
  secrets: string[]
): BaselineRow => ({ name, code, options: [{ language }, {}], secrets })

const joinedKeys: BaselineRow[] = [
  splitRow(
    'joined key: three literals',
    `const t = ${joined(['gh', 'p_', GH_BODY], ' + ')};\n`,
    'typescript',
    [GH_BODY]
  ),
  splitRow(
    'joined key: two literals',
    `const t = ${joined(['sk_' + 'live_', STRIPE_BODY], ' + ')};\n`,
    'typescript',
    [STRIPE_BODY]
  ),
  splitRow(
    'joined key: eight literals',
    `const t = ${joined(pieces(SLACK, 8), ' + ')};\n`,
    'typescript',
    pieces(SLACK, 8)
  ),
  splitRow(
    'joined key: adjacent literals in Python',
    `token = (${joined(['gh', 'p_', GH_BODY], ' ')})\n`,
    'python',
    [GH_BODY]
  ),
  splitRow(
    'joined key: adjacent literals in C',
    `const char *t = ${joined(['sk_' + 'live_', STRIPE_BODY], '\n    ')};\n`,
    'c',
    [STRIPE_BODY]
  ),
  // The stated limit: as 1.19.2 reads it.
  splitRow(
    'joined key: pieces in variables',
    `const a = "gh";\nconst b = "p_";\nconst c = "${GH_BODY}";\nconst t = a + b + c;\n`,
    'typescript',
    [GH_BODY]
  ),
]

const rawStrings: BaselineRow[] = [
  ['c++ raw string: a delimiter', `R"d(AcmeLedger )" x )d"; int customerTotal; char c = '"';\n`],
  [
    'c++ raw string: a quote inside',
    'const char *q = R"(say "AcmePay" twice)"; int acme_refunds;\n',
  ],
  ['c++ raw string: a backslash', 'auto p = R"(C:\\acme_corp\\ledger)"; int settleInvoice();\n'],
  [
    'c++ raw string: two lines',
    'auto s = R"sql(SELECT "customerTotal"\nFROM acme_corp)sql"; int n;\n',
  ],
].map(([name, code]) => ({ name: name!, code: code!, options: [{ language: 'c' as const }, {}] }))

// ─── Credentials by format, by name, over lines and on a command line ───────
//
// The values below are shared with the tests of each rule, so a row here and
// its test read the same text.

const HEX = '0123456789abcdef'
const BECH32 = 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'
const BASE64 = BASE62 + '+/'

/** The pieces of a value a record may hold apart: masking splits a value at
 *  punctuation and leaves leading digits where they stand. */
export const piecesOf = (value: string): string[] => [
  value,
  ...value
    .split(/[^A-Za-z0-9_]+/)
    .flatMap((p) => [p, p.replace(/^\d+/, '')])
    .filter((p) => p.length >= 6),
]

export interface ProviderKey {
  provider: string
  /** A made-up key of the format, never written whole in a file. */
  key: string
  /** The same, one character short of what the format's rule takes. */
  short: string
}
const provider = (
  provider: string,
  prefix: string[],
  body: string,
  least: number
): ProviderKey => ({
  provider,
  key: prefix.join('') + body,
  short: prefix.join('') + body.slice(0, least - 1),
})

/** One key per provider format 1.19.2 has no rule for. */
export const PROVIDER_KEYS: ProviderKey[] = [
  provider(
    'GitHub fine-grained token',
    ['github', '_pat_'],
    made(201, 22) + '_' + made(202, 59),
    36
  ),
  provider('DigitalOcean token', ['dop', '_v1_'], made(203, 64, HEX), 32),
  provider('DigitalOcean OAuth token', ['doo', '_v1_'], made(204, 64, HEX), 32),
  provider('Twilio API key', ['S', 'K'], made(205, 32, HEX), 32),
  provider('Stripe webhook secret', ['whsec', '_'], made(206, 32), 24),
  provider('Google OAuth access token', ['ya', '29.'], made(207, 40) + '-' + made(208, 30), 20),
  provider('Sentry personal token', ['sntryu', '_'], made(209, 64, HEX), 64),
  {
    provider: 'Sentry organisation token',
    key: 'sntrys' + '_' + made(210, 60, BASE64) + '_' + made(211, 43, BASE64),
    short: 'sntrys' + '_' + made(210, 60, BASE64) + '_' + made(211, 42, BASE64),
  },
  provider('Linear API key', ['lin', '_api_'], made(212, 40), 32),
  provider('Vault token', ['hv', 's.'], made(213, 90), 24),
  provider('age secret key', ['AGE-SECRET', '-KEY-1'], made(214, 58, BECH32), 58),
  provider('Heroku token', ['HR', 'KU-'], made(215, 60), 36),
  provider(
    'Slack app-level token',
    ['xa', 'pp-'],
    '1-A' + made(216, 10) + '-' + made(217, 40, HEX),
    10
  ),
]

/** Formats no vendor document states (or states too loosely to anchor on):
 *  read as 1.19.2 read them. */
export const UNLISTED_KEYS: { provider: string; key: string }[] = [
  { provider: 'Google OAuth client secret', key: 'GOC' + 'SPX-' + made(220, 28) },
  { provider: 'Google refresh token', key: '1' + '//0g' + made(221, 60) },
  {
    provider: 'HubSpot private app token',
    key: 'pat' + '-na1-' + made(222, 8, HEX) + '-' + made(223, 12, HEX),
  },
  { provider: 'Mailchimp key', key: made(224, 32, HEX) + '-us' + '12' },
  { provider: 'Telegram bot token', key: made(225, 9, '123456789') + ':' + 'AA' + made(226, 33) },
  { provider: 'Vault token before 1.10', key: 's' + '.' + made(227, 24) },
]

/** A token of no listed format: 40 characters of letters and digits. */
export const OPAQUE = made(230, 40)
/** Ordinary text of the same shape as a key. */
export const COMMIT_ID = made(231, 40, HEX)
export const UUID = [8, 4, 4, 4, 12].map((n, i) => made(232 + i, n, HEX)).join('-')
export const INTEGRITY = 'sha512-' + made(240, 86, BASE64) + '=='

const code = (name: string, text: string, secrets: string[] = []): BaselineRow => ({
  name,
  code: text,
  options: [{ language: 'typescript' }, {}],
  secrets: secrets.flatMap(piecesOf),
})
const filed = (
  name: string,
  text: string,
  fileKind: NonNullable<AnonymizeOptions['fileKind']>,
  secrets: string[] = []
): BaselineRow => ({
  name,
  code: text,
  options: [{ fileKind }],
  secrets: secrets.flatMap(piecesOf),
})

const providerKeys: BaselineRow[] = [
  ...PROVIDER_KEYS.flatMap(({ provider, key, short }) => [
    code(`format: ${provider}, assigned`, `const note = "${key}"\n`, [key]),
    code(`format: ${provider}, an argument`, `send("${key}")\n`, [key]),
    filed(`format: ${provider}, a shell word`, `echo ${key}\n`, 'shell', [key]),
    code(`format: ${provider}, one character short`, `const note = "${short}"\n`, [short]),
  ]),
  ...UNLISTED_KEYS.map(({ provider, key }) =>
    code(`format: ${provider}, not listed`, `const note = "${key}"\n`, [key])
  ),
]

const context: BaselineRow[] = [
  code('context: a credential word after the value', `send("${OPAQUE}", { token: true })\n`, [
    OPAQUE,
  ]),
  code('context: a credential word in a comment', `const note = "${OPAQUE}" // the API key\n`, [
    OPAQUE,
  ]),
  filed('context: after -p on any command', `acmectl sync -p ${OPAQUE} --all\n`, 'shell', [OPAQUE]),
  code('context: none', `const note = "${OPAQUE}"\n`, [OPAQUE]),
  code('context: a commit id beside an author', `const author = pick("${COMMIT_ID}")\n`),
  code('context: a commit id', `const commit = "${COMMIT_ID}"\n`),
  code('context: a UUID', `const tenantId = "${UUID}"\n`),
  {
    name: 'context: a lockfile integrity string',
    code: `{ "integrity": "${INTEGRITY}" }\n`,
    options: [{ path: 'package-lock.json' }, {}],
    // Not a credential: veiled so the record holds no long base64 run.
    secrets: piecesOf(INTEGRITY),
  },
  code(
    'context: a file that names the kind Secret',
    "type Kind = { kind: 'Secret' }\nexport function describeCustomer(customerName: string) {\n  const node = { kind: 'Secret', label: customerName }\n  return node\n}\n"
  ),
]

/** The credential names read beside the English ones. */
export const LOCAL_NAMES = [
  'haslo',
  'hasło',
  'sekret',
  'klucz_api',
  'kennwort',
  'geheimnis',
  'api_schluessel',
  'api_schlüssel',
  'contrasena',
  'contraseña',
  'clave_api',
  'mdp',
  'senha',
  'segredo',
  'wachtwoord',
  'kodikos',
  'synthimatiko',
  'κωδικός',
  'συνθηματικό',
]
/** Names 1.19.2 reads already, and names that only look like one. */
export const PINNED_NAMES = ['passwort', 'motdepasse', 'mot_de_passe', 'secreto']
export const ORDINARY_NAMES = [
  'geheimnisvoll',
  'senhaForte',
  'mdpath',
  'klucz',
  'schluessel',
  'clave',
  'sleutel',
  'tajne',
  'geheim',
  'parola',
]
export const LOCAL_VALUE = made(250, 7) + '!' + made(251, 6)
export const SENTENCE = 'zielona papuga na dachu'

const localNames: BaselineRow[] = [
  ...[...LOCAL_NAMES, ...PINNED_NAMES].flatMap((name) => [
    code(`name: ${name}, in code`, `const ${name} = "${LOCAL_VALUE}"\n`, [LOCAL_VALUE]),
    filed(`name: ${name}, in YAML`, `${name}: ${LOCAL_VALUE}\nport: 8080\n`, 'yaml', [LOCAL_VALUE]),
    filed(`name: ${name}, in an env file`, `${name.toUpperCase()}=${LOCAL_VALUE}\n`, 'dotenv', [
      LOCAL_VALUE,
    ]),
  ]),
  code('name: a prefix in camel case', `const dbHaslo = "${LOCAL_VALUE}"\n`, [LOCAL_VALUE]),
  code('name: a prefix in snake case', `const user_kennwort = "${LOCAL_VALUE}"\n`, [LOCAL_VALUE]),
  ...ORDINARY_NAMES.map((name) =>
    code(`name: ${name}, an ordinary name`, `const ${name} = "${SENTENCE}"\n`)
  ),
]

export const LINES = [made(260, 12), made(261, 12), made(262, 12)] as const
const [L1, L2, L3] = LINES

/** A credential value over several lines, or on the line after its name. */
export const MULTI_LINE: { name: string; path: string; text: string; lines: string[] }[] = [
  {
    name: 'YAML folded, stripped',
    path: 'a.yml',
    text: `token: >-\n  ${L1}\n  ${L2}\n  ${L3}\nname: x\n`,
    lines: [L1, L2, L3],
  },
  {
    name: 'YAML folded',
    path: 'a.yml',
    text: `token: >\n  ${L1}\n  ${L2}\nname: x\n`,
    lines: [L1, L2],
  },
  {
    name: 'YAML literal',
    path: 'a.yml',
    text: `password: |\n  ${L1}\n  ${L2}\nname: x\n`,
    lines: [L1, L2],
  },
  {
    name: 'YAML literal, stripped',
    path: 'a.yml',
    text: `password: |-\n  ${L1}\n\n  ${L2}\n# next\nname: x\n`,
    lines: [L1, L2],
  },
  {
    name: 'YAML literal, indented by two',
    path: 'a.yml',
    text: `db:\n  password: |2\n    ${L1}\n    ${L2}\n  name: x\n`,
    lines: [L1, L2],
  },
  {
    name: 'YAML literal, at the end of the file',
    path: 'a.yml',
    text: `password: |\n  ${L1}\n  ${L2}`,
    lines: [L1, L2],
  },
  {
    name: 'YAML double-quoted over two lines',
    path: 'a.yml',
    text: `api_key: "${L1}\n  ${L2}"\nname: x\n`,
    lines: [L1, L2],
  },
  {
    name: 'TypeScript joined over a line break',
    path: 'a.ts',
    text: `const password = "${L1}" +\n  "${L2}";\n`,
    lines: [L1, L2],
  },
  {
    name: 'TypeScript typed, value on the next line',
    path: 'a.ts',
    text: `const password: string =\n  "${L1}";\n`,
    lines: [L1],
  },
  {
    name: 'TypeScript property, value on the next line',
    path: 'a.ts',
    text: `const o = {\n  password:\n    "${L1}"\n}\n`,
    lines: [L1],
  },
  {
    name: 'Python in parentheses',
    path: 'a.py',
    text: `password = (\n  "${L1}"\n  "${L2}"\n)\n`,
    lines: [L1, L2],
  },
  {
    name: 'Python backslash continuation',
    path: 'a.py',
    text: `secret = "${L1}" \\\n  "${L2}"\n`,
    lines: [L1, L2],
  },
]
/** Shapes 1.19.2 redacts whole already. */
export const MULTI_LINE_PINNED: typeof MULTI_LINE = [
  {
    name: 'YAML value alone on the next line',
    path: 'a.yml',
    text: `secret:\n  ${L1}\nname: x\n`,
    lines: [L1],
  },
  {
    name: 'TypeScript value after a bare =',
    path: 'a.ts',
    text: `const password =\n  "${L1}";\n`,
    lines: [L1],
  },
  {
    name: 'env value quoted over three lines',
    path: '.env',
    text: `API_SECRET="${L1}\n${L2}\n${L3}"\nNAME=x\n`,
    lines: [L1, L2, L3],
  },
]
/** What follows a credential name is not its value, or cannot be told to be:
 *  as 1.19.2 reads it. */
export const MULTI_LINE_KEPT: { name: string; path: string; text: string }[] = [
  {
    name: 'YAML block under an ordinary key',
    path: 'a.yml',
    text: `notes: |\n  ${L1}\n  ${L2}\nname: x\n`,
  },
  { name: 'a call on the next line', path: 'a.ts', text: `const password =\n  load("${L1}");\n` },
  {
    name: 'a name on the next line',
    path: 'a.ts',
    text: `const password =\n  fallback;\nconst label = "${L1}";\n`,
  },
  {
    name: 'a new statement on the next line',
    path: 'a.ts',
    text: `let password\nconst label = "${L1}";\n`,
  },
  {
    name: 'a literal wrapped in a call',
    path: 'a.java',
    text: `private final String password = new String("${L1}");\n`,
  },
  { name: 'a name looked up', path: 'a.py', text: `password = os.getenv(\n  "DB_PASSWORD"\n)\n` },
  {
    name: 'an arrow function that returns a literal',
    path: 'a.ts',
    text: `const tokenLabel = () =>\n  "${L1}";\n`,
  },
  {
    name: 'a docstring under a function',
    path: 'a.py',
    text: `def read_token():\n    """Reads ${L1} from disk."""\n    return 1\n`,
  },
]
const pathLanguage = (path: string): AnonymizeOptions =>
  path.endsWith('.ts')
    ? { language: 'typescript' }
    : path.endsWith('.py')
      ? { language: 'python' }
      : path.endsWith('.java')
        ? { language: 'java' }
        : path.endsWith('.yml')
          ? { fileKind: 'yaml' }
          : { fileKind: 'dotenv' }
const multiLine: BaselineRow[] = [
  ...[...MULTI_LINE, ...MULTI_LINE_PINNED].map(({ name, path, text, lines }) => ({
    name: `lines: ${name}`,
    code: text,
    options: [pathLanguage(path)],
    secrets: lines.flatMap(piecesOf),
  })),
  ...MULTI_LINE_KEPT.map(({ name, path, text }) => ({
    name: `lines: ${name}`,
    code: text,
    options: [pathLanguage(path)],
    secrets: [L1],
  })),
]

export const PW = made(270, 12)
export const TOKEN = made(271, 40)

/** A password on a login command line, by the command's own manual. */
export const LOGINS: { name: string; line: string; secret: string }[] = [
  { name: 'docker login -p', line: `docker login -u a -p ${PW} reg.example`, secret: PW },
  { name: 'docker login -p, attached', line: `docker login -u a -p${PW} reg.example`, secret: PW },
  { name: 'podman login -p', line: `podman login -u a -p ${PW} reg.example`, secret: PW },
  { name: 'nerdctl login -p', line: `nerdctl login -u a -p "${PW}" reg.example`, secret: PW },
  {
    name: 'helm registry login -p',
    line: `helm registry login reg.example -u a -p ${PW}`,
    secret: PW,
  },
  { name: 'az login -p', line: `az login -u a@b.example -p ${PW}`, secret: PW },
  { name: 'smbclient -U', line: `smbclient //h/s -U u%${PW}`, secret: PW },
  { name: 'vault login', line: `vault login ${TOKEN}`, secret: TOKEN },
  { name: 'htpasswd -b', line: `htpasswd -b f u ${PW}`, secret: PW },
  { name: 'htpasswd -nb', line: `htpasswd -nbB u ${PW}`, secret: PW },
  {
    name: 'Authorization: token',
    line: `curl -H "Authorization: token ${TOKEN}" https://api.example.com/x`,
    secret: TOKEN,
  },
  {
    name: 'Authorization: ApiKey',
    line: `curl -H "Authorization: ApiKey ${TOKEN}" https://api.example.com/x`,
    secret: TOKEN,
  },
  {
    name: 'Proxy-Authorization: Digest',
    line: `curl -H "Proxy-Authorization: Digest ${TOKEN}" https://api.example.com/x`,
    secret: TOKEN,
  },
]
/** Forms 1.19.2 redacts already. */
export const LOGINS_PINNED: typeof LOGINS = [
  {
    name: 'docker login --password',
    line: `docker login --username a --password ${PW} reg.example`,
    secret: PW,
  },
  {
    name: 'docker login --password=',
    line: `docker login --username a --password=${PW} reg.example`,
    secret: PW,
  },
  {
    name: 'an X-API-Key header',
    line: `curl -H "X-API-Key: ${TOKEN}" https://api.example.com/x`,
    secret: TOKEN,
  },
  {
    name: 'Authorization: Bearer',
    line: `curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com/x`,
    secret: TOKEN,
  },
]
/** The same flag where it is no password, and what the text cannot tell. */
export const LOGINS_KEPT: { name: string; line: string }[] = [
  { name: 'docker run -p', line: 'docker run -p 8080:80 -d nginx' },
  { name: 'docker run --name login -p', line: 'docker run --name login -p 8080:80 nginx' },
  { name: 'ssh -p', line: 'ssh -p 2222 deploy@host.example' },
  { name: 'psql -p', line: 'psql -h db -p 5432 -U app shop' },
  {
    name: 'docker login -p with a variable',
    line: 'docker login -u a -p "$REGISTRY_PW" reg.example',
  },
  { name: 'vault login by another method', line: 'vault login -method=userpass username=deploy' },
  { name: 'htpasswd that prompts', line: 'htpasswd -c /etc/acme/users deploy' },
  { name: 'a here-string', line: `ftp -n h <<< "user u ${PW}"` },
  {
    name: 'authorization in a sentence',
    line: 'The authorization server metadata lists every endpoint.',
  },
]
/** Each line as a shell script, as text of no kind, as a workflow step and as
 *  an indented block of a document. */
export const PLACES: {
  place: string
  options: AnonymizeOptions
  wrap: (line: string) => string
}[] = [
  { place: 'a shell script', options: { fileKind: 'shell' }, wrap: (line) => `${line}\n` },
  { place: 'text of no kind', options: {}, wrap: (line) => `${line}\n` },
  {
    place: 'a workflow step',
    options: { fileKind: 'yaml' },
    wrap: (line) => `steps:\n  - run: ${line}\n`,
  },
  { place: 'a document', options: { fileKind: 'text' }, wrap: (line) => `Run:\n\n    ${line}\n` },
]
const logins: BaselineRow[] = [
  ...[...LOGINS, ...LOGINS_PINNED].flatMap(({ name, line, secret }) =>
    PLACES.map(({ place, options, wrap }) => ({
      name: `login: ${name}, in ${place}`,
      code: wrap(line),
      options: [options],
      secrets: piecesOf(secret),
    }))
  ),
  ...LOGINS_KEPT.flatMap(({ name, line }) =>
    PLACES.map(({ place, options, wrap }) => ({
      name: `login: ${name}, in ${place}`,
      code: wrap(line),
      options: [options],
      secrets: piecesOf(PW),
    }))
  ),
  code(
    'login: an Authorization header in code',
    `const h = { "Authorization": "token ${TOKEN}" }\n`,
    [TOKEN]
  ),
]

export const OWN_ROWS: BaselineRow[] = [
  ...samples,
  ...tripleQuoted,
  ...commentOpeners,
  ...lineEnds,
  ...urlParameters,
  ...keyMaterial,
  ...joinedKeys,
  ...rawStrings,
  ...providerKeys,
  ...context,
  ...localNames,
  ...multiLine,
  ...logins,
]

/** Tracked files past this size are not part of the repository check. */
export const REPOSITORY_LIMIT = 400_000

/** How many redaction tokens an engine leaves in a file, called as the CLI
 *  calls it: the language and the kind from the path. */
export function redactionCount(
  engine: {
    anonymize: (code: string, options: AnonymizeOptions) => { anonymized: string }
    fileKindOf: (path: string) => AnonymizeOptions['fileKind']
    languageOfPath: (path: string) => AnonymizeOptions['language'] | null
  },
  path: string,
  text: string
): number {
  const fileKind = engine.fileKindOf(path)
  const language = engine.languageOfPath(path) ?? 'auto'
  const { anonymized } = engine.anonymize(text, { language, ...(fileKind ? { fileKind } : {}) })
  return anonymized.match(/__REDACTED_[A-Z_]+_\d+__/g)?.length ?? 0
}

/** Every row: this file's, and those of the fixtures that already exist as
 *  frozen arrays (syntax-corpus.ts, manual-marks.ts). */
export function baselineRows(from: {
  syntaxes: readonly SyntaxCase[]
  values: readonly string[]
  marks: readonly MarkRow[]
  held: Record<string, string>
}): BaselineRow[] {
  return [
    ...OWN_ROWS,
    ...from.syntaxes.flatMap(({ format, path, text }) =>
      from.values.map((value) => ({
        name: `syntax: ${format}: ${value}`,
        code: text(value),
        options: [{ path }, {}],
      }))
    ),
    ...from.marks.map(({ name, code, manual, path }) => ({
      name: `mark: ${name}`,
      code,
      options: [
        { existingMap: from.held, path },
        { existingMap: from.held, path, manual },
      ],
    })),
  ]
}

/** `value` with each of the row's planted credentials replaced by a marker, so
 *  the record holds none of them. Longest first: a piece may lie in another. */
export function veiled<T>(value: T, secrets: readonly string[] = []): T {
  let text = JSON.stringify(value)
  const order = [...new Set(secrets)].filter((s) => s !== '').sort((a, b) => b.length - a.length)
  order.forEach((secret, i) => {
    text = text.split(JSON.stringify(secret).slice(1, -1)).join(`<secret ${i}>`)
  })
  return JSON.parse(text) as T
}
