// Native extension hooks (ADR-0077).
//
// Two capabilities, both deliberately narrow:
//   1. register a tool that joins the same catalogue as built-ins — visible to
//      the model only when the agent card allows it, so it costs no context
//      until it is actually usable;
//   2. register a context provider bound to a moment of the turn, so data is
//      pulled when needed instead of being parked in the prompt for the whole
//      conversation.
//
// A hook is operator code running in the agent process. It adds a primitive,
// never a privilege: effect and tier are mandatory, and the executor still
// applies capability matrix, approvals and audit.

export type HookContextPoint = 'pre-prompt' | 'post-tool' | 'pre-provider'

export type ExtensionHookRefusal =
  | 'invalid-tool'
  | 'invalid-provider'
  | 'duplicate-tool'
  | 'registration-after-install'

export class ExtensionHookError extends Error {
  constructor(readonly reason: ExtensionHookRefusal) {
    super(`extension hook refused: ${reason}`)
    this.name = 'ExtensionHookError'
  }
}

export interface HookTool {
  name: string
  description: string
  /** Mandatory: the executor refuses a tool that does not declare what it does. */
  effect: 'read' | 'write'
  tier: 0 | 1 | 2 | 3
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>): Promise<string>
}

export interface HookContextProvider {
  at: HookContextPoint
  name: string
  /** Bounded fragment for this turn only; it never joins the stable prefix. */
  provide(input: { query: string }): Promise<string | null>
}

export interface HookInstallContext {
  registerTool(tool: HookTool): void
  registerContextProvider(provider: HookContextProvider): void
}

export interface ExtensionHookModule {
  install(context: HookInstallContext): void | Promise<void>
}

export interface LoadedExtensionHooks {
  tools: HookTool[]
  providers: HookContextProvider[]
  /** Hooks that threw during load; the rest still work. */
  failed: Array<{ file: string; reason: string }>
  disabled: boolean
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const MAX_FRAGMENT_BYTES = 32 * 1024
const MAX_TOOLS_PER_HOOK = 16

function validTool(tool: unknown): tool is HookTool {
  if (typeof tool !== 'object' || tool === null) return false
  const candidate = tool as HookTool
  return typeof candidate.name === 'string' && TOOL_NAME.test(candidate.name) &&
    typeof candidate.description === 'string' && candidate.description.trim() !== '' &&
    (candidate.effect === 'read' || candidate.effect === 'write') &&
    Number.isInteger(candidate.tier) && candidate.tier >= 0 && candidate.tier <= 3 &&
    typeof candidate.inputSchema === 'object' && candidate.inputSchema !== null &&
    typeof candidate.execute === 'function'
}

function validProvider(provider: unknown): provider is HookContextProvider {
  if (typeof provider !== 'object' || provider === null) return false
  const candidate = provider as HookContextProvider
  return (candidate.at === 'pre-prompt' || candidate.at === 'post-tool' || candidate.at === 'pre-provider') &&
    typeof candidate.name === 'string' && candidate.name.trim() !== '' &&
    typeof candidate.provide === 'function'
}

export interface ExtensionHooksInput {
  /** Hook files in load order; the caller lists and sorts them. */
  files: readonly string[]
  /** Dynamic import seam so loading is testable without touching the disk. */
  importModule(file: string): Promise<ExtensionHookModule>
  /** Consecutive failures already recorded; the mechanism disables itself past the limit. */
  previousFailures?: number
  failureLimit?: number
  onDisabled?: (failures: number) => void
}

/**
 * Load hooks in the given order. A hook that throws is skipped with its reason
 * recorded; repeated failures disable the whole mechanism, because a broken
 * extension must not send the runtime into a restart loop.
 */
export async function loadExtensionHooks(
  input: ExtensionHooksInput,
): Promise<LoadedExtensionHooks> {
  const limit = input.failureLimit ?? 5
  const previous = input.previousFailures ?? 0
  if (previous >= limit) {
    input.onDisabled?.(previous)
    return { tools: [], providers: [], failed: [], disabled: true }
  }

  const tools: HookTool[] = []
  const providers: HookContextProvider[] = []
  const failed: Array<{ file: string; reason: string }> = []
  const names = new Set<string>()

  for (const file of input.files) {
    // Files whose name starts with an underscore are ignored by convention: it
    // is the operator's way to park a hook without deleting it.
    if (file.split('/').pop()?.startsWith('_') === true) continue
    const registeredHere: HookTool[] = []
    const providersHere: HookContextProvider[] = []
    let installed = false
    try {
      const module = await input.importModule(file)
      if (typeof module?.install !== 'function') throw new ExtensionHookError('invalid-tool')
      await module.install({
        registerTool(tool) {
          // Registration after install() returned would bypass the validation
          // window and the duplicate check below.
          if (installed) throw new ExtensionHookError('registration-after-install')
          if (!validTool(tool)) throw new ExtensionHookError('invalid-tool')
          if (names.has(tool.name)) throw new ExtensionHookError('duplicate-tool')
          if (registeredHere.length >= MAX_TOOLS_PER_HOOK) {
            throw new ExtensionHookError('invalid-tool')
          }
          names.add(tool.name)
          registeredHere.push({ ...tool })
        },
        registerContextProvider(provider) {
          if (installed) throw new ExtensionHookError('registration-after-install')
          if (!validProvider(provider)) throw new ExtensionHookError('invalid-provider')
          providersHere.push({ ...provider })
        },
      })
      installed = true
      tools.push(...registeredHere)
      providers.push(...providersHere)
    } catch (error) {
      installed = true
      // Roll back this hook's names so a later hook may still use them.
      for (const tool of registeredHere) names.delete(tool.name)
      failed.push({
        file,
        reason: error instanceof ExtensionHookError ? error.reason : 'load-failed',
      })
    }
  }

  return { tools, providers, failed, disabled: false }
}

export interface HookContextFragment {
  name: string
  text: string
  /** Always untrusted: a hook may lift data from anywhere (ADR-0028). */
  provenance: 'untrusted'
}

/**
 * Collect context for one moment of the turn. Fragments are bounded and belong
 * to this turn only; a provider that fails or overruns is skipped rather than
 * failing the turn.
 */
export async function collectHookContext(input: {
  providers: readonly HookContextProvider[]
  at: HookContextPoint
  query: string
  maxFragmentBytes?: number
}): Promise<HookContextFragment[]> {
  const limit = input.maxFragmentBytes ?? MAX_FRAGMENT_BYTES
  const fragments: HookContextFragment[] = []
  for (const provider of input.providers) {
    if (provider.at !== input.at) continue
    let text: string | null
    try {
      text = await provider.provide({ query: input.query })
    } catch {
      continue
    }
    if (typeof text !== 'string' || text === '') continue
    if (Buffer.byteLength(text, 'utf8') > limit) continue
    fragments.push({ name: provider.name, text, provenance: 'untrusted' })
  }
  return fragments
}
