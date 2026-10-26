// Random texts for the masking property (review of da4ff84): credentials,
// regulated numbers, map placeholders and ordinary names, in random order.
// Seeded, so a failure reproduces. Shared by the lib and the hook tests.
// Ordinary names are one lowercase word, which no rule masks by its shape.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const IBANS = ['GB29NWBK60161331926819', 'DE89370400440532013000']

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!
}
function str(r: () => number, alphabet: string, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(r() * alphabet.length)]
  return out
}

export type Case = {
  text: string
  map: Record<string, string>
  names: string[]
  placeholders: string[]
}

/** One random text: pieces in random order, on one line or several. */
export function generate(seed: number): Case {
  const r = rng(seed)
  const map: Record<string, string> = {}
  const names: string[] = []
  const placeholders: string[] = []
  const pieces: string[] = []
  const n = 2 + Math.floor(r() * 6)
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(r() * 7)
    if (kind === 0) pieces.push(`key AKIA${str(r, UPPER + '0123456789', 16)}`)
    else if (kind === 1) pieces.push(`token ghp_${str(r, ALNUM, 36)}`)
    else if (kind === 2) pieces.push(`secret = "${str(r, '0123456789', 14)}"`)
    else if (kind === 3) pieces.push(`password = "${str(r, ALNUM, 12)}7"`)
    else if (kind === 4) pieces.push(`postgres://app:${str(r, ALNUM, 10)}9@db${i}.internal:5432/x`)
    else if (kind === 5) pieces.push(`iban ${pick(r, IBANS)}`)
    else {
      const name = `ledger${str(r, 'abcdefghij', 4)}`
      const p = `__VAR__${100 + i}`
      map[p] = `unusedName${i}`
      names.push(name)
      placeholders.push(p)
      pieces.push(`${name}(${p})`)
    }
  }
  const sep = () => pick(r, ['\n', ' ; ', '\n\n', ', '])
  return { text: pieces.join(sep()), map, names, placeholders }
}
