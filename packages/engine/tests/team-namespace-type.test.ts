import { expect, expectTypeOf, it } from 'vitest'
import { analyzeTeamNamespace, type TeamNamespaceAnalysis } from '../src/index.js'

// Spec 066: every analysis says how many local-family keys it dropped. An
// optional field let a builder forget it and read as "none dropped".
it('localDropped is a required number on every analysis', () => {
  expectTypeOf<TeamNamespaceAnalysis['localDropped']>().toEqualTypeOf<number>()
  // @ts-expect-error - an analysis without localDropped does not type-check
  const missing: TeamNamespaceAnalysis = { namespace: {}, aliases: {}, conflicts: {}, highest: {} }
  void missing
  expect(analyzeTeamNamespace([]).localDropped).toBe(0)
})
