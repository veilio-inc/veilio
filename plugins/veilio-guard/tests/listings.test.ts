// Guard decision 1 (spec 050 amendment R7): the skill and agent listings
// Claude Code adds to a request go as written for the entries that come from
// Claude Code itself or from a plugin installed in the plugin cache. Every
// other entry is masked as before: the project's and the user's own skills
// and agents, MCP skills, --plugin-dir and synced plugins, and anything whose
// provenance the guard cannot establish. Provenance comes from the engine
// ($.command.list, agent.offer) and the plugin cache, never from the text.
// Shapes recorded from Claude Code 2.1.310 (research R7).
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, ROOT, STRIPE, type Options } from './helpers.ts'

const CONFIG = '/home/dev/.claude'
const CACHE = `${CONFIG}/plugins/cache/claude-plugins-official`
// `review` and `skills` are project names here, so masking would change the
// public descriptions below: what reaches the model shows which path it took.
const MAP = { __CLS__1: CANARY, __FN__2: 'review', __VAR__3: 'skills' }

const BUILTIN_REVIEW = 'Review the current diff for review bugs, with WebFetch where it helps.'
const PLUGIN_SKILL =
  'You MUST use this before any creative work - creating features, building components, or review of skills.'
const PLUGIN_AGENT = 'Deeply analyzes existing codebase features to review how skills are wired.'
const BUILTIN_AGENT = 'Fast read-only search agent to review code and find skills.'

const SKILL_HEAD = 'The following skills are available for use with the Skill tool:\n\n'
const AGENT_HEAD = 'Available agent types for the Agent tool:\n'

const installed = {
  version: 2,
  plugins: {
    'superpowers@claude-plugins-official': [
      { scope: 'user', installPath: `${CACHE}/superpowers/7.0.0`, version: '7.0.0' },
    ],
    'feature-dev@claude-plugins-official': [
      { scope: 'user', installPath: `${CACHE}/feature-dev/1.0.0`, version: '1.0.0' },
    ],
    // Installed from a directory outside the plugin cache: the user's own.
    'devplug@local': [{ scope: 'user', installPath: '/work/devplug', version: '0.1.0' }],
  },
}

// The plugin's own files in the cache. The description is folded, as YAML
// writes a long one: its words are the listing's, in order.
const CACHED: Record<string, string> = {
  [`${CONFIG}/plugins/installed_plugins.json`]: JSON.stringify(installed),
  [`${CACHE}/superpowers/7.0.0/skills/brainstorming/SKILL.md`]: `---\nname: brainstorming\ndescription: >-\n  You MUST use this before any creative work - creating features,\n  building components, or review of skills.\n---\nBody.\n`,
  [`${CACHE}/feature-dev/1.0.0/agents/code-explorer.md`]: `---\nname: code-explorer\ndescription: ${PLUGIN_AGENT}\n---\nYou explore.\n`,
  '/work/devplug/skills/tool/SKILL.md': `---\nname: tool\ndescription: Devplug tool for ${CANARY}.\n---\n`,
}

type Skill = { name: string; description: string; source: string; plugin?: string | null }
type Offer = { agent: string; description: string; source: string; provider: any }

const ENGINE = { plugin: 'engine', tier: 'core' }

function setUp(
  on: any,
  skills: Skill[] | 'deny',
  opts: Options & { env?: Record<string, string | undefined>; files?: Record<string, string> } = {}
) {
  const files = { [`${ROOT}/.veilio/map.json`]: mapFile(MAP), ...CACHED, ...opts.files }
  const p = project(on, files, opts)
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  on('agent.offer', () => ({ isOffered: true }))
  on('command.list', () => (skills === 'deny' ? { deny: 'no commands' } : { value: skills }))
  const env = opts.env ?? { HOME: '/home/dev' }
  on('env.get', (_: any, e: any) => ({ value: env[e.name] }))
  return p
}

async function offer($: any, offers: Offer[]) {
  for (const o of offers) await $.agent.offer(o)
}

const skillListing = (lines: string[]) => SKILL_HEAD + lines.join('\n')
const agentListing = (lines: string[]) =>
  AGENT_HEAD +
  lines.join('\n') +
  '\n\nWhen you launch multiple agents for independent work, send them in a single message.'

async function attach($: any, type: string, text: string): Promise<string> {
  const r: any = await $.prompt.attachment({ type, text, origin: { kind: 'engine' } })
  return r.text
}

const builtinReview: Skill = { name: 'code-review', description: BUILTIN_REVIEW, source: 'builtin' }
const pluginSkill: Skill = {
  name: 'superpowers:brainstorming',
  description: PLUGIN_SKILL,
  source: 'plugin',
  plugin: 'superpowers',
}

test("a built-in skill and an installed plugin's skill reach the model as written", async ($, on) => {
  setUp(on, [builtinReview, pluginSkill])
  const text = skillListing([
    `- code-review: ${BUILTIN_REVIEW}`,
    `- superpowers:brainstorming: ${PLUGIN_SKILL}`,
  ])
  const out = await attach($, 'skill_listing', text)
  expect(out).toContain(`- code-review: ${BUILTIN_REVIEW}`)
  expect(out).toContain(`- superpowers:brainstorming: ${PLUGIN_SKILL}`)
})

test('a public entry listed by its name alone reaches the model as written', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach($, 'skill_listing', skillListing(['- code-review', '- review']))
  expect(out).toContain('- code-review\n')
  // `review` is no skill the engine reported: masked.
  expect(out).toContain('- __FN__2')
})

test("a project skill's entry is masked", async ($, on) => {
  setUp(on, [
    builtinReview,
    { name: 'deploy', description: `Deploys ${CANARY} to review skills.`, source: 'user' },
  ])
  const text = skillListing([
    `- deploy: Deploys ${CANARY} to review skills.`,
    `- code-review: ${BUILTIN_REVIEW}`,
  ])
  const out = await attach($, 'skill_listing', text)
  expect(out).not.toContain(CANARY)
  expect(out).toContain('- deploy: Deploys __CLS__1 to __FN__2 __VAR__3.')
  expect(out).toContain(`- code-review: ${BUILTIN_REVIEW}`)
})

// ~/.claude/skills: the engine reports it as `user` too, and so is masked.
test("a user skill's entry is masked", async ($, on) => {
  setUp(on, [{ name: 'speckit-plan', description: `Plans ${CANARY} skills.`, source: 'user' }])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- speckit-plan: Plans ${CANARY} skills.`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).toContain('__VAR__3')
})

test("an MCP server's skill entry is masked", async ($, on) => {
  setUp(on, [{ name: 'db:query', description: `Queries ${CANARY} skills.`, source: 'mcp' }])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- db:query: Queries ${CANARY} skills.`])
  )
  expect(out).not.toContain(CANARY)
})

test('an entry the engine did not report is masked', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- code-review: ${BUILTIN_REVIEW}`, `- ledger: ${CANARY} for review skills.`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).toContain('- ledger: __CLS__1 for __FN__2 __VAR__3.')
})

test('a public name with another description is masked', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- code-review: Review ${CANARY} skills.`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).toContain('Review __CLS__1 __VAR__3.')
})

test('a public entry continued past its end is masked', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- code-review: ${BUILTIN_REVIEW} Then review ${CANARY}.`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).not.toContain(BUILTIN_REVIEW)
})

test('a public entry that does not start a line is masked', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`${CANARY} skills - code-review: ${BUILTIN_REVIEW}`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).not.toContain(BUILTIN_REVIEW)
})

test('a line after a public entry is masked', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- code-review: ${BUILTIN_REVIEW}`, `${CANARY} skills`])
  )
  expect(out).toContain(`- code-review: ${BUILTIN_REVIEW}`)
  expect(out).toContain('__CLS__1 __VAR__3')
  expect(out).not.toContain(CANARY)
})

// --plugin-dir: Claude Code names the plugin without its marketplace, so a
// plugin under development can share an installed one's name. Its entry
// passes only if the installed copy in the cache holds the same words.
test("a --plugin-dir plugin's skill under an installed plugin's name is masked", async ($, on) => {
  const own = `Brainstorms ${CANARY} skills.`
  setUp(on, [{ ...pluginSkill, description: own }])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- superpowers:brainstorming: ${own}`])
  )
  expect(out).not.toContain(CANARY)
})

test('a plugin installed from outside the plugin cache is masked', async ($, on) => {
  const own = `Devplug tool for ${CANARY}.`
  setUp(on, [{ name: 'devplug:tool', description: own, source: 'plugin', plugin: 'devplug' }])
  const out = await attach($, 'skill_listing', skillListing([`- devplug:tool: ${own}`]))
  expect(out).not.toContain(CANARY)
})

test("an installed plugin's skill with no file in the cache is masked", async ($, on) => {
  const desc = 'Debugs review skills step by step.'
  setUp(on, [
    { name: 'superpowers:debugging', description: desc, source: 'plugin', plugin: 'superpowers' },
  ])
  const out = await attach($, 'skill_listing', skillListing([`- superpowers:debugging: ${desc}`]))
  expect(out).toContain('__FN__2 __VAR__3')
})

// The cache's own file, reached through `..` from the commands folder: the
// mock file system does not resolve `..`, so the path is listed as written,
// as the operating system would resolve it.
test("a skill whose name climbs out of the plugin's folder is masked", async ($, on) => {
  const name = 'superpowers:../skills/brainstorming/SKILL'
  setUp(on, [{ name, description: PLUGIN_SKILL, source: 'plugin', plugin: 'superpowers' }], {
    files: {
      [`${CACHE}/superpowers/7.0.0/commands/../skills/brainstorming/SKILL.md`]:
        CACHED[`${CACHE}/superpowers/7.0.0/skills/brainstorming/SKILL.md`]!,
    },
  })
  const out = await attach($, 'skill_listing', skillListing([`- ${name}: ${PLUGIN_SKILL}`]))
  expect(out).not.toContain(PLUGIN_SKILL)
})

test('when the skills cannot be listed, the whole listing is masked', async ($, on) => {
  setUp(on, 'deny')
  const out = await attach($, 'skill_listing', skillListing([`- code-review: ${BUILTIN_REVIEW}`]))
  expect(out).toContain('__FN__2')
  expect(out).not.toContain(BUILTIN_REVIEW)
})

test('when the installed plugins cannot be read, only built-ins pass', async ($, on) => {
  setUp(on, [builtinReview, pluginSkill], {
    failRead: (path) => path.endsWith('installed_plugins.json'),
  })
  const out = await attach(
    $,
    'skill_listing',
    skillListing([
      `- code-review: ${BUILTIN_REVIEW}`,
      `- superpowers:brainstorming: ${PLUGIN_SKILL}`,
    ])
  )
  expect(out).toContain(`- code-review: ${BUILTIN_REVIEW}`)
  expect(out).not.toContain(PLUGIN_SKILL)
})

test('with no home or config directory, only built-ins pass', async ($, on) => {
  setUp(on, [builtinReview, pluginSkill], { env: {} })
  const out = await attach(
    $,
    'skill_listing',
    skillListing([
      `- code-review: ${BUILTIN_REVIEW}`,
      `- superpowers:brainstorming: ${PLUGIN_SKILL}`,
    ])
  )
  expect(out).toContain(`- code-review: ${BUILTIN_REVIEW}`)
  expect(out).not.toContain(PLUGIN_SKILL)
})

test('CLAUDE_CONFIG_DIR names where the plugin cache is', async ($, on) => {
  setUp(on, [pluginSkill], { env: { CLAUDE_CONFIG_DIR: CONFIG, HOME: '/elsewhere' } })
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- superpowers:brainstorming: ${PLUGIN_SKILL}`])
  )
  expect(out).toContain(`- superpowers:brainstorming: ${PLUGIN_SKILL}`)
})

const builtinAgent: Offer = {
  agent: 'Explore',
  description: BUILTIN_AGENT,
  source: 'built-in',
  provider: ENGINE,
}
const pluginAgent: Offer = {
  agent: 'feature-dev:code-explorer',
  description: PLUGIN_AGENT,
  source: 'plugin',
  provider: { plugin: 'feature-dev@claude-plugins-official', tier: 'user' },
}

test("a built-in agent and an installed plugin's agent reach the model as written", async ($, on) => {
  setUp(on, [])
  await offer($, [builtinAgent, pluginAgent])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([
      `- Explore: ${BUILTIN_AGENT} (Tools: All tools except Agent)`,
      `- feature-dev:code-explorer: ${PLUGIN_AGENT} (Tools: Glob, Grep)`,
    ])
  )
  expect(out).toContain(`- Explore: ${BUILTIN_AGENT} (Tools: `)
  expect(out).toContain(`- feature-dev:code-explorer: ${PLUGIN_AGENT} (Tools: `)
})

test("an agent's tools are masked as before", async ($, on) => {
  setUp(on, [])
  await offer($, [builtinAgent])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([`- Explore: ${BUILTIN_AGENT} (Tools: ${CANARY})`])
  )
  expect(out).toContain(`- Explore: ${BUILTIN_AGENT} (Tools: __CLS__1)`)
})

test('a project agent is masked', async ($, on) => {
  setUp(on, [])
  const desc = `Reconciles ${CANARY} skills.`
  await offer($, [
    builtinAgent,
    {
      agent: 'ledger',
      description: desc,
      source: 'projectSettings',
      provider: { plugin: 'project', tier: 'user' },
    },
  ])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([`- Explore: ${BUILTIN_AGENT} (Tools: *)`, `- ledger: ${desc} (Tools: All tools)`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).toContain(`- Explore: ${BUILTIN_AGENT} (Tools: *)`)
})

test('a user agent is masked', async ($, on) => {
  setUp(on, [])
  const desc = `Audits ${CANARY} skills.`
  await offer($, [
    {
      agent: 'auditor',
      description: desc,
      source: 'userSettings',
      provider: { plugin: 'user', tier: 'user' },
    },
  ])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([`- auditor: ${desc} (Tools: *)`])
  )
  expect(out).not.toContain(CANARY)
})

test("--plugin-dir and synced plugins' agents are masked", async ($, on) => {
  setUp(on, [])
  await offer($, [
    { ...pluginAgent, provider: { plugin: 'feature-dev@inline', tier: 'user' } },
    {
      agent: 'brand-voice:writer',
      description: PLUGIN_AGENT,
      source: 'plugin',
      provider: { plugin: 'brand-voice@synced', tier: 'user' },
    },
  ])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([
      `- feature-dev:code-explorer: ${PLUGIN_AGENT} (Tools: *)`,
      `- brand-voice:writer: ${PLUGIN_AGENT} (Tools: *)`,
    ])
  )
  expect(out).not.toContain(PLUGIN_AGENT)
})

test("a built-in agent's name from a plugin is masked", async ($, on) => {
  setUp(on, [])
  await offer($, [
    { ...builtinAgent, provider: { plugin: 'feature-dev@claude-plugins-official', tier: 'user' } },
  ])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([`- Explore: ${BUILTIN_AGENT} (Tools: *)`])
  )
  expect(out).not.toContain(BUILTIN_AGENT)
})

test('with no agent offers, the agent listing is masked', async ($, on) => {
  setUp(on, [])
  const out = await attach(
    $,
    'agent_listing_delta',
    agentListing([`- Explore: ${BUILTIN_AGENT} (Tools: *)`])
  )
  expect(out).not.toContain(BUILTIN_AGENT)
  expect(out).toContain('__FN__2')
})

test('an agent offer still reaches the engine as it came', async ($, on) => {
  setUp(on, [])
  const r: any = await ($ as any).agent.offer(builtinAgent)
  expect(r).toEqual({ isOffered: true })
})

test('a credential in a listing is redacted', async ($, on) => {
  setUp(on, [builtinReview, { name: 'pay', description: `Pays with ${STRIPE}.`, source: 'user' }])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- code-review: ${BUILTIN_REVIEW}`, `- pay: Pays with ${STRIPE}.`])
  )
  expect(out).not.toContain(STRIPE)
  expect(out).toContain(`- code-review: ${BUILTIN_REVIEW}`)
})

// The last gate: a public entry is held as written, so a credential in one
// would pass the masking around it. The whole listing then goes through full
// masking instead.
test('a public entry that holds a credential is masked in full', async ($, on) => {
  const desc = `Pays with ${STRIPE} and review skills.`
  setUp(on, [{ name: 'pay', description: desc, source: 'builtin' }])
  const out = await attach($, 'skill_listing', skillListing([`- pay: ${desc}`]))
  expect(out).not.toContain(STRIPE)
  expect(out).toContain('__VAR__3')
})

test('another kind of reminder holding a public entry is masked as before', async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach($, 'edited_text_file', `- code-review: ${BUILTIN_REVIEW}`)
  expect(out).not.toContain(BUILTIN_REVIEW)
  expect(out).toContain('__FN__2')
})

test("a listing holding the guard's mark characters gets no exemption", async ($, on) => {
  setUp(on, [builtinReview])
  const out = await attach(
    $,
    'skill_listing',
    skillListing([`- code-review: ${BUILTIN_REVIEW}`, `\u00000\u0001 ${CANARY}`])
  )
  expect(out).not.toContain(CANARY)
  expect(out).not.toContain(BUILTIN_REVIEW)
})
