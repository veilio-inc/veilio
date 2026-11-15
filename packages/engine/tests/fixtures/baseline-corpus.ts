// The frozen corpus behind baseline-1.19.1.json: what the published engine
// 1.19.1 answered for each row and option set is recorded there, once, and
// baseline-1.19.1.test.ts holds every later build to it, row by row. A row
// that may differ is listed in baseline-exceptions.ts with the reason.
//
// Never edit a row: its recorded answer would no longer be the published
// engine's. A new row needs its own record, taken from 1.19.1 again.
//
// No imports that run: baseline-1.19.1.gen.mjs loads this file with Node
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
    // As 1.19.1 already reads them.
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
  // As 1.19.1 already reads them.
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
  // As 1.19.1 already reads it.
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
  // As 1.19.1 already reads it.
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
  // The stated limit: as 1.19.1 reads it.
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

export const OWN_ROWS: BaselineRow[] = [
  ...samples,
  ...tripleQuoted,
  ...commentOpeners,
  ...lineEnds,
  ...urlParameters,
  ...keyMaterial,
  ...joinedKeys,
  ...rawStrings,
]

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
