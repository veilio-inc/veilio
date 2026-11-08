// Spec 078 US7 (A#11, FR-016): anonymize_file and scan_secrets never read a
// file on the guard's raw-only list - one list, the engine's - as written or
// through a link.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTool, type ToolContext } from '../src/tools.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

const said = (path: string) =>
  `"${path}" is on Veilio's raw-only list (.env, private keys, credential stores, .veilio/); Veilio never reads it. Ask the user for what you need from it.`

let cwd: string
let ctx: ToolContext
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-raw-only-'))
  ctx = { cwd, mapPath: null }
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true })
    writeFileSync(join(cwd, rel), text)
  }
  put('.env', 'DB_HOST=db.internal.example\n')
  put('.env.local', 'DB_HOST=db.internal.example\n')
  put('keys/id_rsa', 'not a real key\n')
  put('config/.aws/credentials', '[default]\nregion = eu-west-1\n')
  put('.veilio/map.json', '{"version":1,"map":{"__CLS__1":"PaymentGateway"}}\n')
  put('src/pay.ts', 'export class PaymentGateway {}\n')
  symlinkSync(join(cwd, '.env'), join(cwd, 'notes.txt'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe('raw-only paths (spec 078)', () => {
  for (const tool of ['anonymize_file', 'scan_secrets'])
    for (const path of [
      '.env',
      '.env.local',
      'keys/id_rsa',
      'config/.aws/credentials',
      '.veilio/map.json',
      'notes.txt',
    ])
      it(`${tool} refuses ${path}`, () => {
        const r = callTool(tool, { path }, ctx)
        expect(r.isError).toBe(true)
        expect(r.text).toContain(said(path))
        expect(r.text).not.toContain('db.internal')
        expect(r.text).not.toContain('PaymentGateway')
      })

  // Security review of the MCP raw-only refusal: Windows spellings, string-level
  // (a live Windows check is still owed).
  for (const tool of ['anonymize_file', 'scan_secrets'])
    for (const path of ['.env::$DATA', '.env:x', '.env.', 'ENV~1', 'keys/id_rsa.'])
      it(`${tool} refuses the Windows spelling ${path}`, () => {
        const r = callTool(tool, { path }, ctx)
        expect(r.isError).toBe(true)
        expect(r.text).toContain(said(path))
      })

  it('the configured map file, and its aliases and reservations beside it, are refused wherever they live', () => {
    mkdirSync(join(cwd, 'store'))
    writeFileSync(
      join(cwd, 'store', 'custom-map.json'),
      '{"version":1,"map":{"__CLS__1":"PaymentGateway"}}\n'
    )
    writeFileSync(join(cwd, 'store', 'aliases.json'), '{"aliases":{"__CLS__9":"InvoiceBuilder"}}\n')
    writeFileSync(join(cwd, 'store', 'reserved.json'), '{}\n')
    const custom = { ...ctx, mapPath: 'store/custom-map.json' }
    for (const tool of ['anonymize_file', 'scan_secrets'])
      for (const path of ['store/custom-map.json', 'store/aliases.json', 'store/reserved.json']) {
        const r = callTool(tool, { path }, custom)
        expect(`${tool} ${path}: ${r.text}`).toContain(said(path))
        expect(r.text).not.toContain('PaymentGateway')
        expect(r.text).not.toContain('InvoiceBuilder')
      }
  })

  // Spec 085 handover H10 (lead L10): comment text and the aliases file too.
  it('H10: .npmrc and .env comment text, and .veilio/aliases.json, are refused', () => {
    writeFileSync(join(cwd, '.npmrc'), '; legacy token notrealtoken123abc\n')
    writeFileSync(join(cwd, '.env'), '# old key: fakeTokenPaymentGateway42\n')
    writeFileSync(
      join(cwd, '.veilio', 'aliases.json'),
      '{"aliases":{"__VAR__8":"fakeAliasValue"}}\n'
    )
    for (const path of ['.npmrc', '.env', '.veilio/aliases.json']) {
      const r = callTool('anonymize_file', { path }, ctx)
      expect(r.text).toContain(said(path))
      expect(r.text).not.toMatch(/notrealtoken123abc|fakeTokenPaymentGateway42|fakeAliasValue/)
    }
  })

  // Review round 1 item 10: the project's own raw-only patterns, from
  // .veilio/guard.json as the guard reads them, as written and through a link.
  it("a path on the project's own raw-only list in .veilio/guard.json is refused", () => {
    writeFileSync(join(cwd, '.veilio', 'guard.json'), '{"rawOnly":["secrets/**"]}\n')
    mkdirSync(join(cwd, 'secrets'))
    writeFileSync(join(cwd, 'secrets', 'prod.yaml'), 'db_host: db.internal.example\n')
    symlinkSync(join(cwd, 'secrets', 'prod.yaml'), join(cwd, 'prod-notes.txt'))
    for (const tool of ['anonymize_file', 'scan_secrets'])
      for (const path of ['secrets/prod.yaml', 'prod-notes.txt']) {
        const r = callTool(tool, { path }, ctx)
        expect(`${tool} ${path}: ${r.text}`).toContain(said(path))
        expect(r.text).not.toContain('db.internal')
      }
    expect(callTool('anonymize_file', { path: 'src/pay.ts' }, ctx).isError).toBeFalsy()
  })

  // Security review of the git and MCP changes: guard.json's patterns are the
  // project root's, so a server started in a subdirectory matches them from
  // the root, as the guard does.
  it("from a subdirectory, guard.json's patterns are matched from the project root", () => {
    writeFileSync(
      join(cwd, '.veilio', 'guard.json'),
      '{"rawOnly":["secrets/**","app/private/**"]}\n'
    )
    mkdirSync(join(cwd, 'secrets'))
    writeFileSync(join(cwd, 'secrets', 'x.yaml'), 'db_host: db.internal.example\n')
    mkdirSync(join(cwd, 'app', 'private'), { recursive: true })
    writeFileSync(join(cwd, 'app', 'private', 'y.yaml'), 'db_host: db.internal.example\n')
    const sub = { ...ctx, cwd: join(cwd, 'app') }
    for (const path of ['../secrets/x.yaml', 'private/y.yaml']) {
      const r = callTool('anonymize_file', { path }, sub)
      expect(`${path}: ${r.text}`).toContain(said(path))
      expect(r.text).not.toContain('db.internal')
    }
  })

  // Review round 3 #3: a guard.json that cannot be read refuses, as it
  // stops the guard; it is never read as "no patterns".
  it.skipIf(process.getuid?.() === 0)(
    'a .veilio/guard.json that cannot be read refuses every file',
    () => {
      const path = join(cwd, '.veilio', 'guard.json')
      writeFileSync(path, '{"rawOnly":["secrets/**"]}\n')
      chmodSync(path, 0o000)
      try {
        const r = callTool('anonymize_file', { path: 'src/pay.ts' }, ctx)
        expect(r.isError).toBe(true)
        expect(r.text).toContain(
          'Veilio could not read .veilio/guard.json, so it cannot tell which files are raw-only. Fix it, or ask the user for what you need.'
        )
      } finally {
        chmodSync(path, 0o600)
      }
    }
  )

  it('a .veilio/guard.json that is not valid JSON refuses every file', () => {
    writeFileSync(join(cwd, '.veilio', 'guard.json'), '{"rawOnly": [\n')
    const r = callTool('anonymize_file', { path: 'src/pay.ts' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(
      '.veilio/guard.json is not valid JSON, so Veilio cannot tell which files are raw-only. Fix it, or ask the user for what you need.'
    )
    expect(r.text).not.toContain('PaymentGateway')
  })

  it('a source file still works', () => {
    expect(callTool('anonymize_file', { path: 'src/pay.ts' }, ctx).isError).toBeFalsy()
    expect(callTool('scan_secrets', { path: 'src/pay.ts' }, ctx).isError).toBeFalsy()
  })
})
