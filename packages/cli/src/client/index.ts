// `@veilio-inc/cli/client`: the Cloud operations the CLI's commands and the MCP
// server's map tools share (spec 052 §3). One implementation of every rule and
// one table of words for every refusal, so the two clients cannot drift apart.
// Nothing here prints; every operation answers an `Outcome`.

export * from './wording.js'
export * from './maps.js'
export * from './keys.js'
export {
  personalMapsKeyPath,
  readPersonalMapsKey,
  removePersonalMapsKey,
} from './personal-maps-key.js'
