import { describe, it, expect } from 'vitest'
import { extractIdentifiers, anonymize, restore } from '../src/engine.js'

// Standard library method names (forEach, map, push, has, then, split, …) are
// public API, not private identifiers. Masking them strips structural signal an
// AI needs to reason about the code, for no privacy gain. Keep them readable.

describe('extractIdentifiers leaves standard built-in methods unmasked', () => {
  it('does not extract Array iteration methods', () => {
    const ids = extractIdentifiers(
      'items.forEach(f); items.map(g); items.filter(h); items.reduce(r); items.find(p); items.some(s); items.every(e)'
    )
    for (const m of ['forEach', 'map', 'filter', 'reduce', 'find', 'some', 'every']) {
      expect(ids).not.toContain(m)
    }
  })

  it('does not extract Array mutation/query methods', () => {
    const ids = extractIdentifiers(
      'a.push(1); a.includes(2); a.indexOf(3); a.slice(0); a.concat(b); a.flatMap(f)'
    )
    for (const m of ['push', 'includes', 'indexOf', 'slice', 'concat', 'flatMap']) {
      expect(ids).not.toContain(m)
    }
  })

  it('does not extract Map/Set methods', () => {
    const ids = extractIdentifiers('m.has(k); m.add(v); m.keys(); m.values(); m.entries()')
    for (const m of ['has', 'add', 'keys', 'values', 'entries']) {
      expect(ids).not.toContain(m)
    }
  })

  it('does not extract Promise methods', () => {
    const ids = extractIdentifiers('p.then(a).finally(c); Promise.all(xs); Promise.allSettled(ys)')
    for (const m of ['then', 'all', 'allSettled']) {
      expect(ids).not.toContain(m)
    }
  })

  it('does not extract common string methods', () => {
    const ids = extractIdentifiers(
      's.split(","); s.trim(); s.replace(a, b); s.toLowerCase(); s.startsWith(p); s.padStart(3)'
    )
    for (const m of ['split', 'trim', 'replace', 'toLowerCase', 'startsWith', 'padStart']) {
      expect(ids).not.toContain(m)
    }
  })

  it('still masks a real domain identifier sitting next to a built-in', () => {
    const ids = extractIdentifiers('orders.forEach(processOrder)')
    expect(ids).toContain('processOrder')
    expect(ids).not.toContain('forEach')
  })

  it('the async-race sample keeps forEach readable end to end', () => {
    const code = 'userIds.forEach((id) => results.push(fetchProfile(id)))'
    const { anonymized, map } = anonymize(code)
    expect(anonymized).toContain('forEach')
    expect(anonymized).toContain('push')
    expect(anonymized).not.toContain('userIds')
    expect(anonymized).not.toContain('fetchProfile')
    expect(restore(anonymized, map).restored).toBe(code)
  })
})
