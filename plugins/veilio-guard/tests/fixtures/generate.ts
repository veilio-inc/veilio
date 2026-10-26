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
const CONSONANTS = 'bcdfghjklmnpqrstvwxz'
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const WORDS = ['Required', 'Configuration', 'Optional', 'Disabled', 'required', 'postgres']
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
  const words: string[] = []
  const pieces: string[] = []
  const n = 2 + Math.floor(r() * 6)
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(r() * 13)
    if (kind === 0) {
      const v = `AKIA${str(r, UPPER + '0123456789', 16)}`
      pieces.push(`key ${v}`)
    } else if (kind === 1) {
      const v = `ghp_${str(r, ALNUM, 36)}`
      pieces.push(`token ${v}`)
    } else if (kind === 2) {
      // Random digits: some the scanner destroys, some too plain it only
      // reports. The oracle follows its verdict (review of 0ef312b).
      const v = str(r, '0123456789', 14)
      pieces.push(`secret = "${v}"`)
    } else if (kind === 3) {
      const v = `${str(r, ALNUM, 12)}7`
      pieces.push(`password = "${v}"`)
    } else if (kind === 4) {
      const v = `${str(r, ALNUM, 10)}9`
      pieces.push(`postgres://app:${v}@db${i}.internal:5432/x`)
    } else if (kind === 5) {
      const v = pick(r, IBANS)
      pieces.push(`iban ${v}`)
    } else if (kind === 6) {
      // A high-entropy password, then the same value glued to a flag, inside
      // a word and run into another key (review of 6e14ec6).
      // Structural signal: upper case, lower case and a digit (research R4).
      const strong = (n: number) =>
        `${str(r, UPPER, 1)}${str(r, 'abcdefghijklmnopqrstuvwxyz', 1)}${Math.floor(r() * 10)}${str(r, ALNUM, n)}`
      const v = strong(7)
      const v2 = strong(9)
      pieces.push(`password = "${v}"`)
      pieces.push(`api_key = "${v2}"`)
      pieces.push(pick(r, [`mysql -u app -p${v}`, `x${v}y`, `${v}${v2}`, `--token=${v}`]))
    } else if (kind === 7) {
      // A schema's ordinary word as a value: the word elsewhere is code.
      const word = pick(r, WORDS)
      pieces.push(`{ password: '${word}' }`)
      words.push(`see the ${word} field`)
      pieces.push(`see the ${word} field`)
    } else if (kind === 9) {
      // The final review's reproduced leaks (of d55d9e2): a dotted bearer
      // token, then the same value bare.
      const v = [5, 5, 5, 5].map((k) => str(r, ALNUM, k - 1) + Math.floor(r() * 10)).join('.')
      pieces.push(`Authorization: Bearer ${v}`)
      pieces.push(`retry with ${v}`)
    } else if (kind === 10) {
      // Random letters with few vowels and digits at one end, then bare.
      const letters = str(r, CONSONANTS, 12)
      const digits = str(r, '0123456789', 4)
      const v = r() < 0.5 ? `${letters}${digits}` : `${digits}${letters.toUpperCase()}`
      pieces.push(`password = "${v}"`)
      pieces.push(`echo ${v}`)
    } else if (kind === 11) {
      // Random letter blocks shaped like a variable's name.
      const v = [4, 4, 4, 4].map((k) => str(r, UPPER, k)).join('_')
      pieces.push(`password = "${v}"`)
    } else if (kind === 12) {
      // One random segment after a path's start, or dotted random segments,
      // then bare.
      const v = pick(r, [
        `/${str(r, ALNUM, 15)}7`,
        `./${str(r, ALNUM, 14)}3`,
        [1, 2, 3, 4]
          .map(
            () =>
              `${str(r, CONSONANTS, 1).toUpperCase()}${str(r, CONSONANTS, 1)}${Math.floor(r() * 10)}`
          )
          .join('.'),
      ])
      pieces.push(`password = "${v}"`)
      pieces.push(`cat ${v}`)
    } else {
      const name = `ledger${str(r, 'abcdefghij', 4)}`
      const p = `__VAR__${100 + i}`
      map[p] = `unusedName${i}`
      names.push(name)
      placeholders.push(p)
      pieces.push(`${name}(${p})`)
    }
  }
  const sep = () => pick(r, ['\n', ' ; ', '\n\n', ', '])
  return { text: pieces.join(sep()), map, names: [...names, ...words], placeholders }
}
