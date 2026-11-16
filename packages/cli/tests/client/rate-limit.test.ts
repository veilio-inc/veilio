import { describe, it, expect, afterEach, vi } from 'vitest'
import { CloudError, listMaps, listPersonalEnvelopes } from '../../src/cloud.js'

// A 429 is said as a rate limit, with the time to wait when the instance
// names one in whole seconds, and the request is never repeated here: a
// caller that may wait does so itself, once.

const CREDENTIAL = { token: 'tok', account: 'me@example.test', instance: 'https://veilio.test' }

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => vi.unstubAllGlobals())

async function failure(call: () => Promise<unknown>): Promise<CloudError> {
  try {
    await call()
  } catch (err) {
    if (err instanceof CloudError) return err
    throw err
  }
  throw new Error('the call did not fail')
}

const IN_A_MINUTE = 'Cloud is limiting requests from this session. Try again in a minute.'

describe('a request answered 429', () => {
  it.each([
    ['7', 7, '7 seconds'],
    ['60', 60, '60 seconds'],
    ['2', 2, '2 seconds'],
    ['1', 1, '1 second'],
    ['61', 61, '61 seconds'],
    ['120', 120, '120 seconds'],
    ['3600', 3600, '3600 seconds'],
  ])('Retry-After: %s is the time to wait', async (header, seconds, said) => {
    const fetchMock = answer(429, { error: 'Too many requests' }, { 'Retry-After': header })
    const err = await failure(() => listMaps(CREDENTIAL))
    expect(err.message).toBe(`Cloud is limiting requests from this session. Try again in ${said}.`)
    expect(err).toMatchObject({ kind: 'server', status: 429, retryAfter: seconds })
    expect(err.body).toEqual({ error: 'Too many requests' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no header', {}],
    ['zero', { 'Retry-After': '0' }],
    ['more than an hour', { 'Retry-After': '3601' }],
    ['five digits', { 'Retry-After': '36000' }],
    ['an HTTP date', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
    ['not a number', { 'Retry-After': 'soon' }],
    ['a fraction', { 'Retry-After': '7.5' }],
    ['a negative number', { 'Retry-After': '-3' }],
  ])('%s: try again in a minute, and no time to wait', async (_, headers) => {
    const fetchMock = answer(429, { error: 'Too many requests' }, headers)
    const err = await failure(() => listMaps(CREDENTIAL))
    expect(err.message).toBe(IN_A_MINUTE)
    expect(err).toMatchObject({ kind: 'server', status: 429 })
    expect(err.retryAfter).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a body that is not JSON is a rate limit all the same', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 }))
    )
    expect((await failure(() => listMaps(CREDENTIAL))).message).toBe(IN_A_MINUTE)
  })

  it('the reservation cap keeps its own words, its reason and its body', async () => {
    const body = { error: 'No more blocks today.', reason: 'cap', retryAt: '2026-10-21T09:14:00Z' }
    const fetchMock = answer(429, body, { 'Retry-After': '7' })
    const err = await failure(() => listMaps(CREDENTIAL))
    expect(err.message).toBe('No more blocks today.')
    expect(err).toMatchObject({ kind: 'server', status: 429 })
    expect(err.body).toEqual(body)
    expect(err.retryAfter).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('another failure is said as before', async () => {
    answer(503, {}, { 'Retry-After': '7' })
    const err = await failure(() => listMaps(CREDENTIAL))
    expect(err.message).toBe('https://veilio.test returned 503')
    expect(err.retryAfter).toBeUndefined()
  })
})

describe('the personal envelopes, in one request', () => {
  it('asks once, with no project, and gives what the instance listed', async () => {
    const listed = {
      maps: [{ id: 'm1', updated_at: 'u1', identifier_count: 2, map_data: '{}' }],
      unreadable: ['m2'],
    }
    const fetchMock = answer(200, listed)
    expect(await listPersonalEnvelopes({ ...CREDENTIAL, project: 'p-billing' })).toEqual(listed)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://veilio.test/api/maps/personal-envelopes')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('an instance without the listing answers 404, for the caller to fall back on', async () => {
    answer(404, { error: 'Map not found' })
    expect(await failure(() => listPersonalEnvelopes(CREDENTIAL))).toMatchObject({
      kind: 'server',
      status: 404,
    })
  })
})
