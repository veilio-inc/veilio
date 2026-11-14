// Spec 093: the inputs whose masking, with and without manual marks, must stay
// exactly what origin/main 05931b6 gave. A first fix changed the masking of a
// mark inside a longer name and was withdrawn (it put a credential in the map,
// and left a mark readable); the round trip is fixed in `restore` instead, so
// `anonymize` must not differ from that build for any of these.
//
// manual-marks-main.json holds that build's answers. To regenerate it, build
// origin/main's engine and run:
//   node tests/fixtures/manual-marks-main.gen.mjs <path to that build>/engine.js

// Provider-shaped values are built here, never written whole.
const KEY = 'sk_' + 'live_' + '4eC39HqLyjWDAcmetT1zdp7dc'
const PASSWORD = 'Zt4pw-AcmeHunter7Zq9-x9Kd2'

export const MODES = ['redact', 'warn', 'off'] as const
/** A map the text was masked with before: `__CLS__1` in a row is a placeholder. */
export const HELD = { __CLS__1: 'Client' }
const MARKS = ['Acme', 'ACME', '8841']

export interface Row {
  name: string
  code: string
  manual: string[]
  path?: string
}

export const ROWS: Row[] = [
  { name: 'inside a name', code: 'const u = ACME_API_URL + new AcmeClient()', manual: MARKS },
  { name: 'alone in a string', code: 'log("Acme")', manual: MARKS },
  { name: 'inside a name in a string', code: 'log("PaymentAcmeGateway down")', manual: MARKS },
  { name: 'in a comment', code: 'const total = 1 // ask Acme and the AcmeTeam', manual: MARKS },
  {
    name: 'beside Polish letters',
    code: 'const firma = "ŻAcmeClient" // AcmeŻółć',
    manual: MARKS,
  },
  { name: 'beside Greek letters', code: '// ΑAcmeΔ und AcmeClientΩ', manual: MARKS },
  { name: 'inside a number', code: '// acct 88412037\nwire(88412037)', manual: MARKS },
  {
    name: 'beside a placeholder',
    code: '// AcmeŻ__CLS__1 and Acme__CLS__1x here',
    manual: MARKS,
  },
  { name: 'inside a key', code: `const k = "${KEY}"`, manual: MARKS },
  {
    name: 'inside a password of a connection string',
    code: `const dsn = "postgres://svc:${PASSWORD}@db.internal:5432/app"`,
    manual: MARKS,
  },
  {
    name: 'inside a value under a credential key',
    code: `const password = "${PASSWORD}"`,
    manual: MARKS,
  },
  {
    name: 'a whole part of a credential',
    code: 'const password = "Zt4pw-Acme-x9Kd2"',
    manual: MARKS,
  },
  {
    name: 'inside a credential that holds a placeholder',
    code: 'const password = "Zt4pwŻ__CLS__1ŻAcmeHunter7Zq9"',
    manual: MARKS,
  },
  {
    name: 'in a name that is a credential elsewhere',
    code: 'const password = "AcmeHunter7Zq9"\nlog(AcmeHunter7Zq9)',
    manual: MARKS,
  },
  // Review finding A: the name is a credential further on.
  {
    name: 'in a name that is a credential in a later call',
    code: 'log(AcmeHunter7Zq9)\nlogin(user, password = AcmeHunter7Zq9)',
    manual: ['Acme'],
  },
  {
    name: 'in a name that is a credential in a later YAML key',
    code: 'user: AcmeHunter7Zq9\npassword: AcmeHunter7Zq9\n',
    manual: ['Acme'],
    path: 'config.yaml',
  },
  // Review finding B: two marks side by side.
  {
    name: 'two marks side by side in a comment',
    code: '// invoice for AcmeCorp Ltd',
    manual: ['Acme', 'Corp Ltd'],
  },
  {
    name: 'two marks side by side in a string',
    code: "const who = 'AcmeCorp Ltd'",
    manual: ['Acme', 'Corp Ltd'],
  },
]
