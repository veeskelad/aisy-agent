import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  runtimeProviderTools,
  runtimeToolMinimumTiers,
  type FsPort,
  type ToolCall,
  type ToolExecutionContext,
} from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'
import * as ts from 'typescript'
import {
  liveProviderTools,
  makeLiveToolExecutor,
  type LiveToolExecutorDeps,
} from './live-network-tool-policy.js'

const fs: FsPort = {
  readFile: () => '',
  writeFile: () => undefined,
  listDir: () => [],
  exists: () => false,
}
const fetchUrl = async (url: string): Promise<string> => `text of ${url}`
const baseDeps: LiveToolExecutorDeps = { fs, workspaceRoot: '/work', fetchUrl }
const toolCall = (name: string, args: Record<string, unknown>): ToolCall => ({ name, args })

describe('live network tool policy', () => {
  it('publishes exactly the runtime catalog, network tools included', () => {
    const catalog = runtimeProviderTools().map((tool) => tool.name)
    const actual = liveProviderTools().map((tool) => tool.name)

    expect(actual).toEqual(catalog)
    expect(actual).toHaveLength(19)
    expect(actual).toContain('web_search')
    expect(actual).toContain('fetch_url')
    expect(actual).toContain('deep_research')
    expect(actual).toContain('set_trigger')
    expect(actual).toContain('set_goal')
    expect(actual).toContain('list_sessions')
    expect(actual).toContain('configure_agent')
  })

  it('freezes live catalog membership and top-level tool names', () => {
    const tools = liveProviderTools()
    const extra = runtimeProviderTools()[0]!

    expect(Object.isFrozen(tools)).toBe(true)
    expect(tools.every((tool) => Object.isFrozen(tool))).toBe(true)
    expect(() => tools.push(extra)).toThrow()
    expect(() => { tools[0]!.name = 'smuggled' }).toThrow()
  })

  it('routes web_search through the live executor', async () => {
    const webSearch = vi.fn(async (query: string) => `results for ${query}`)
    const execute = makeLiveToolExecutor({ ...baseDeps, webSearch })

    await expect(execute(toolCall('web_search', { query: 'aisy' })))
      .resolves.toEqual({ ok: true, output: 'results for aisy' })
    expect(webSearch).toHaveBeenCalledOnce()
  })

  it('keeps deep_research behind one approval card', async () => {
    // The whole design of one-tap-per-search rests on this tier: at tier 1 the
    // search would run with no confirmation at all, and the page approvals it
    // answers on the operator's behalf would have no tap behind them.
    const definition = runtimeProviderTools().find((tool) => tool.name === 'deep_research')

    expect(runtimeToolMinimumTiers()['deep_research']).toBe(2)
    expect(definition).toBeDefined()
  })

  it('routes deep_research through the supplied port', async () => {
    const deepResearch = vi.fn(async (question: string, _context?: ToolExecutionContext) =>
      `отчёт по «${question}»`)
    const execute = makeLiveToolExecutor({ ...baseDeps, deepResearch })
    const signal = new AbortController().signal
    const context: ToolExecutionContext = { sessionId: 's1', ordinal: 1, signal }

    await expect(execute(toolCall('deep_research', { question: 'что такое harness' }), context))
      .resolves.toEqual({ ok: true, output: 'отчёт по «что такое harness»' })
    expect(deepResearch).toHaveBeenCalledWith('что такое harness', context)
  })

  it('reports deep_research unavailable when no researcher is wired', async () => {
    const execute = makeLiveToolExecutor(baseDeps)

    await expect(execute(toolCall('deep_research', { question: 'что-нибудь' })))
      .resolves.toEqual({ ok: false, output: 'deep_research: unavailable' })
  })

  it('routes fetch_url through the supplied port', async () => {
    const port = vi.fn(fetchUrl)
    const execute = makeLiveToolExecutor({ ...baseDeps, fetchUrl: port })

    await expect(execute(toolCall('fetch_url', { url: 'https://example.com/a' })))
      .resolves.toEqual({ ok: true, output: 'text of https://example.com/a' })
    expect(port).toHaveBeenCalledOnce()
  })

  it('uses a frozen dependency snapshot that ignores a later port swap', async () => {
    const deps: LiveToolExecutorDeps = { ...baseDeps }
    const execute = makeLiveToolExecutor(deps)
    const unsafe = vi.fn(async () => 'unpinned')
    deps.fetchUrl = unsafe

    await expect(execute(toolCall('fetch_url', { url: 'https://example.com' })))
      .resolves.toEqual({ ok: true, output: 'text of https://example.com' })
    expect(unsafe).not.toHaveBeenCalled()
  })

  it.each([
    ['missing port', { fs, workspaceRoot: '/work' }],
    ['non-callable port', { fs, workspaceRoot: '/work', fetchUrl: 'https://example.com' }],
    ['getter that yields a non-function', Object.defineProperty(
      { fs, workspaceRoot: '/work' },
      'fetchUrl',
      { get: () => null, enumerable: true },
    )],
  ])('refuses to build a live executor with a %s', (_case, forged) => {
    expect(() => makeLiveToolExecutor(forged as unknown as LiveToolExecutorDeps))
      .toThrow('live fetch_url port is required')
  })
})

describe('live binary import guard', () => {
  const sourcePath = fileURLToPath(new URL('./bin/aisy.ts', import.meta.url))
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )

  const namedImports = (moduleName: string): string[] => source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName) return []
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return []
    return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
  })

  const calledIdentifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calledIdentifiers.push(node.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  it('uses only live wrappers instead of raw tool factories', () => {
    const coreImports = namedImports('@aisy/core')
    expect(coreImports).not.toContain('runtimeProviderTools')
    expect(coreImports).not.toContain('makeToolExecutor')
    expect(calledIdentifiers).not.toContain('runtimeProviderTools')
    expect(calledIdentifiers).not.toContain('makeToolExecutor')

    const policyImports = namedImports('../live-network-tool-policy.js')
    expect(policyImports).toEqual(expect.arrayContaining([
      'liveProviderTools',
      'makeLiveToolExecutor',
    ]))
    expect(calledIdentifiers.filter((name) => name === 'liveProviderTools')).toHaveLength(1)
    expect(calledIdentifiers.filter((name) => name === 'makeLiveToolExecutor')).toHaveLength(2)

    const egressImports = namedImports('../pinned-https-egress.js')
    // `makePinnedHttpsJson` is the service road (Serper/Supadata/Apify): the
    // same gauntlet with a method, a credential header and a body. Built once
    // and shared, exactly like the two above it.
    expect(egressImports).toEqual([
      'makePinnedHttpsJson', 'makePinnedHttpsTextGet', 'pinnedBingSearchUrl',
    ])
    expect(calledIdentifiers.filter((name) => name === 'makePinnedHttpsTextGet')).toHaveLength(1)
    expect(calledIdentifiers.filter((name) => name === 'makePinnedHttpsJson')).toHaveLength(1)
    expect(calledIdentifiers.filter((name) => name === 'pinnedBingSearchUrl')).toHaveLength(1)

    // The only way an arbitrary link may be opened is the pinned open fetcher,
    // built once and shared by the main and sub-agent executors.
    expect(namedImports('../page-fetch.js')).toEqual(['makeOpenPageFetch'])
    expect(calledIdentifiers.filter((name) => name === 'makeOpenPageFetch')).toHaveLength(1)
    // The sole remaining global fetch checks npm for an Aisy update. Web search
    // must not add another direct network path.
    expect(calledIdentifiers.filter((name) => name === 'fetch')).toHaveLength(1)
  })
})
