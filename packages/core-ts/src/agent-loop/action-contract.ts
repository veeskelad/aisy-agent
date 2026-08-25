import type {
  ActionContractKind,
  ActionMissingEvidence,
  ContextSpan,
  ModelResponse,
  ToolCall,
  ToolExecutionContext,
} from './types.js'

export interface ActionContract {
  kind: ActionContractKind
  reasonCode: 'ANSWER' | 'INSPECT_VERB' | 'MUTATE_VERB' | 'DELEGATE_VERB'
  /** A mixed operator request must not lose its mutation behind delegation precedence. */
  requiresMutation?: true
}

export type ActionToolFamily = 'inspect' | 'mutate' | 'delegate' | 'unknown'

export interface ActionEvidence {
  tool: string
  family: ActionToolFamily
  successful: boolean
  receipt: boolean
}

export interface ActionContractVerdict {
  satisfied: boolean
  missing: ActionMissingEvidence
  /** Code-owned partial evidence for a mixed delegation + mutation contract. */
  mutationSatisfied?: boolean
}

// A subscription adapter executes Aisy capabilities inside its supervised MCP
// loop, so those calls do not pass through AgentLoop.dispatch(). Keep their
// evidence on an in-process, non-serializable channel: vendor JSON, transcript
// text, cached responses and provider progress cannot manufacture this symbol.
const providerActionEvidence = Symbol('aisy.provider-action-evidence')
const providerToolExecutions = Symbol('aisy.provider-tool-executions')

type AttestedModelResponse = ModelResponse & {
  readonly [providerActionEvidence]?: readonly ActionEvidence[]
  readonly [providerToolExecutions]?: readonly ProviderToolExecution[]
}

/**
 * In-process attestation emitted by a supervised provider-owned tool loop.
 * It is never serialized or accepted from model output. AgentLoop consumes it
 * only for code-owned receipts such as memory.remember/v1.
 */
export interface ProviderToolExecution {
  readonly call: ToolCall
  readonly context: ToolExecutionContext
  readonly result: unknown
}

function frozenClone<T>(value: T): T {
  const cloned = structuredClone(value) as T
  let nodes = 0
  const freeze = (item: unknown, depth: number): void => {
    if (typeof item !== 'object' || item === null) return
    nodes += 1
    if (nodes > 4096 || depth > 32 ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) {
      throw new Error('INVALID_PROVIDER_TOOL_EXECUTION')
    }
    for (const child of Object.values(item)) freeze(child, depth + 1)
    Object.freeze(item)
  }
  freeze(cloned, 0)
  return cloned
}

function attachAttestations(
  response: ModelResponse,
  evidence: readonly ActionEvidence[] | undefined,
  executions: readonly ProviderToolExecution[] | undefined,
): ModelResponse {
  const attached: AttestedModelResponse = { ...response }
  if (evidence !== undefined) {
    Object.defineProperty(attached, providerActionEvidence, {
      configurable: false, enumerable: false, writable: false, value: evidence,
    })
  }
  if (executions !== undefined) {
    Object.defineProperty(attached, providerToolExecutions, {
      configurable: false, enumerable: false, writable: false, value: executions,
    })
  }
  return attached
}

function snapshotProviderEvidence(item: ActionEvidence): Readonly<ActionEvidence> {
  if (typeof item.tool !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.tool) ||
    typeof item.successful !== 'boolean' || typeof item.receipt !== 'boolean') {
    throw new Error('INVALID_PROVIDER_ACTION_EVIDENCE')
  }
  const validFamily = item.tool === 'bash'
    ? item.family === 'inspect' || item.family === 'mutate'
    : item.family === actionToolFamily({ name: item.tool, args: {} })
  if (!validFamily) throw new Error('INVALID_PROVIDER_ACTION_EVIDENCE')
  return Object.freeze({
    tool: item.tool,
    family: item.family,
    successful: item.successful,
    receipt: item.receipt,
  })
}

export function attachProviderActionEvidence(
  response: ModelResponse,
  evidence: readonly ActionEvidence[],
): ModelResponse {
  if (evidence.length > 128) throw new Error('INVALID_PROVIDER_ACTION_EVIDENCE')
  const snapshot = Object.freeze(evidence.map(snapshotProviderEvidence))
  return attachAttestations(
    response,
    snapshot,
    (response as AttestedModelResponse)[providerToolExecutions],
  )
}

export function readProviderActionEvidence(
  response: ModelResponse,
): readonly ActionEvidence[] {
  return (response as AttestedModelResponse)[providerActionEvidence] ?? []
}

export function attachProviderToolExecutions(
  response: ModelResponse,
  executions: readonly ProviderToolExecution[],
): ModelResponse {
  if (executions.length > 128) throw new Error('INVALID_PROVIDER_TOOL_EXECUTION')
  const snapshot = executions.map(item => {
    if (typeof item.call?.name !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(item.call.name) ||
      typeof item.context?.sessionId !== 'string' || item.context.sessionId.length === 0 ||
      (item.context.turnId !== undefined &&
        (typeof item.context.turnId !== 'string' || item.context.turnId.length === 0)) ||
      !Number.isSafeInteger(item.context.ordinal) || item.context.ordinal < 1) {
      throw new Error('INVALID_PROVIDER_TOOL_EXECUTION')
    }
    return Object.freeze<ProviderToolExecution>({
      call: frozenClone(item.call),
      context: Object.freeze({
        sessionId: item.context.sessionId,
        ...(item.context.turnId === undefined ? {} : { turnId: item.context.turnId }),
        ordinal: item.context.ordinal,
      }),
      result: frozenClone(item.result),
    })
  }).sort((left, right) => left.context.ordinal! - right.context.ordinal!)
  if (new Set(snapshot.map(item => item.context.ordinal)).size !== snapshot.length) {
    throw new Error('INVALID_PROVIDER_TOOL_EXECUTION')
  }
  Object.freeze(snapshot)
  return attachAttestations(
    response,
    (response as AttestedModelResponse)[providerActionEvidence],
    snapshot,
  )
}

export function readProviderToolExecutions(
  response: ModelResponse,
): readonly ProviderToolExecution[] {
  return (response as AttestedModelResponse)[providerToolExecutions] ?? []
}

const INFORMATIONAL_PREFIX = /^(?:объясни|расскажи|почему|что такое|можно ли|как (?:мне |нам )?(?:сделать|создать|настроить|установить)|explain|describe|why|what is|how (?:do|can|should|to)\b)/i
// JavaScript's `\b` is ASCII-centric: it does not form reliable boundaries
// around Cyrillic words. Keep Russian alternatives explicit, and use `\b`
// only inside the English-only branches.
const DELEGATE_RE = /(?:делегируй|делегировать|субагент(?:у|ам|а|ы)?|параллельн(?:ый|ые|о) агент)|\b(?:subagents?|spawn (?:a )?subagent|delegate (?:this )?to|parallel agents?)\b/i
const INSPECT_RE = /(?:проверь|проверить|посмотри|изучи|изучить|проанализируй|найди|покажи|прочитай|сверь|протестируй|запусти тесты)|\b(?:inspect|check|verify|analy[sz]e|find|show|read|list|run (?:the )?tests?)\b/i
const MUTATE_RE = /(?:создай|добавь|измени|исправь|обнови|удали|запусти|установи|настрой|отправь|сохрани|запомни|запомнить|перенеси|реализуй|доработай|почини)|\b(?:create|add|change|edit|fix|update|delete|remove|run|install|configure|send|save|remember|move|implement)\b/i
const INSPECTION_OVERRIDE_RE = /(?:запусти тесты|протестируй)|\b(?:run (?:the )?tests?|test)\b/i

const INSPECT_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_memory',
  'fetch_url',
  'fetch_web',
  'web_search',
])
const MUTATE_TOOLS = new Set(['write_file', 'edit_file', 'remember', 'send_message'])
const DELEGATE_TOOLS = new Set(['spawn_subagent'])
const INSPECT_BASH = /^(?:pwd|ls|find|rg|grep|cat|head|tail|sed\s+-n|git\s+(?:status|diff|log|show)|(?:pnpm|npm|yarn|bun|uv|pytest|cargo|go)\s+(?:test|check|lint)|tsc\b)/i

function operatorTexts(spans: ContextSpan[]): string[] {
  return spans
    .filter((span) => span.role === 'user' && span.provenance === 'operator')
    .map((span) => span.text.trim())
    .filter(Boolean)
}

export function classifyActionContract(spans: ContextSpan[]): ActionContract {
  // An informational span must not mask a later imperative operator span.
  const texts = operatorTexts(spans).filter((text) => !INFORMATIONAL_PREFIX.test(text))
  if (texts.length === 0) return { kind: 'answer-only', reasonCode: 'ANSWER' }
  const text = texts.join('\n')
  if (DELEGATE_RE.test(text)) {
    return {
      kind: 'delegate-required',
      reasonCode: 'DELEGATE_VERB',
      ...(MUTATE_RE.test(text) && !INSPECTION_OVERRIDE_RE.test(text)
        ? { requiresMutation: true as const }
        : {}),
    }
  }
  // A mixed “inspect and fix” request needs mutation postconditions. Explicit
  // test-running phrases are the exception: generic “run/запусти” means inspect.
  if (MUTATE_RE.test(text) && !INSPECTION_OVERRIDE_RE.test(text)) {
    return { kind: 'mutate-required', reasonCode: 'MUTATE_VERB' }
  }
  if (INSPECT_RE.test(text)) return { kind: 'inspect-required', reasonCode: 'INSPECT_VERB' }
  if (MUTATE_RE.test(text)) return { kind: 'mutate-required', reasonCode: 'MUTATE_VERB' }
  return { kind: 'answer-only', reasonCode: 'ANSWER' }
}

export function actionToolFamily(call: ToolCall): ActionToolFamily {
  if (DELEGATE_TOOLS.has(call.name)) return 'delegate'
  if (INSPECT_TOOLS.has(call.name)) return 'inspect'
  if (MUTATE_TOOLS.has(call.name)) return 'mutate'
  if (call.name === 'bash') {
    const command = typeof call.args['cmd'] === 'string' ? call.args['cmd'].trim() : ''
    return INSPECT_BASH.test(command) ? 'inspect' : 'mutate'
  }
  return 'unknown'
}

function failedResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null &&
    (result as Record<string, unknown>)['ok'] === false
}

function hasReceipt(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  const value = result as Record<string, unknown>
  return value['verified'] === true ||
    (typeof value['receiptId'] === 'string' && value['receiptId'].length > 0)
}

export function actionEvidence(call: ToolCall, result: unknown): ActionEvidence {
  return {
    tool: call.name,
    family: actionToolFamily(call),
    successful: result !== undefined && !failedResult(result),
    receipt: hasReceipt(result),
  }
}

function mutationVerdict(evidence: ActionEvidence[]): ActionContractVerdict {
  let mutationIndex = -1
  for (let i = evidence.length - 1; i >= 0; i--) {
    const item = evidence[i]!
    if (item.successful && item.family === 'mutate') {
      mutationIndex = i
      break
    }
  }
  if (mutationIndex < 0) return { satisfied: false, missing: 'mutation' }
  const mutation = evidence[mutationIndex]!
  const readback = evidence.slice(mutationIndex + 1)
    .some((item) => item.successful && item.family === 'inspect')
  return mutation.receipt || readback
    ? { satisfied: true, missing: 'none' }
    : { satisfied: false, missing: 'postcondition' }
}

export function evaluateActionContract(
  contract: ActionContract,
  evidence: ActionEvidence[],
  planVerified = false,
): ActionContractVerdict {
  if (contract.kind === 'answer-only' || planVerified) return { satisfied: true, missing: 'none' }

  if (contract.kind === 'inspect-required') {
    const observed = evidence.some((item) => item.successful && item.family === 'inspect')
    return observed
      ? { satisfied: true, missing: 'none' }
      : { satisfied: false, missing: 'observation' }
  }

  if (contract.kind === 'delegate-required') {
    const delegated = evidence.some((item) => item.successful && item.family === 'delegate')
    if (!delegated) {
      return contract.requiresMutation === true
        ? {
            satisfied: false,
            missing: 'delegation',
            mutationSatisfied: mutationVerdict(evidence).satisfied,
          }
        : { satisfied: false, missing: 'delegation' }
    }
    return contract.requiresMutation === true
      ? mutationVerdict(evidence)
      : { satisfied: true, missing: 'none' }
  }

  return mutationVerdict(evidence)
}

export function actionRecoveryInstruction(
  contract: ActionContract,
  verdict: ActionContractVerdict,
): string {
  const mixedMutation = contract.kind === 'delegate-required' && contract.requiresMutation === true
  const nextAction = verdict.missing === 'delegation'
    ? mixedMutation && verdict.mutationSatisfied === true
      ? [
          'Mutation evidence already exists and its postcondition is verified. Do not repeat the mutation.',
          'Call spawn_subagent now with a JSON string such as {"intent":"standalone task"}.',
          'Do not calculate or role-play the subagent result yourself.',
        ].join(' ')
      : [
          'Call spawn_subagent now with a JSON string such as {"intent":"standalone task"}.',
          'Do not calculate or role-play the subagent result yourself.',
          ...(mixedMutation
            ? [
                'This mixed contract also requires its explicit mutation obligation; call the still-missing mutation tool in the same provider turn and do not stop after delegation.',
                'For an explicit memory request, call remember with one exact durable fact about the current operator written naturally in second person, for example {"fact":"ты предпочитаешь краткие отчёты"}.',
                'Do not repeat an effect that already has verified evidence; terminal success requires both delegation and mutation evidence.',
              ]
            : []),
        ].join(' ')
    : mixedMutation
      ? verdict.missing === 'postcondition'
        ? 'Delegation evidence already exists. Do not call spawn_subagent again or repeat the mutation; independently verify the mutation postcondition now.'
        : 'Delegation evidence already exists. Do not call spawn_subagent again. Call the still-missing mutation tool explicitly requested by the operator now. For an explicit memory request, call remember with one exact durable fact about the current operator written naturally in second person, for example {"fact":"ты предпочитаешь краткие отчёты"}.'
      : 'Call a relevant tool now; after a mutation, independently verify the postcondition.'
  return [
    `Action contract: ${contract.kind}.`,
    `Missing evidence: ${verdict.missing}.`,
    `Do not claim completion. ${nextAction}`,
  ].join(' ')
}
