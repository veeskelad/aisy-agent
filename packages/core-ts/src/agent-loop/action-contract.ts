import type {
  ActionContractKind,
  ActionMissingEvidence,
  ContextSpan,
  ToolCall,
} from './types.js'

export interface ActionContract {
  kind: ActionContractKind
  reasonCode: 'ANSWER' | 'INSPECT_VERB' | 'MUTATE_VERB' | 'DELEGATE_VERB'
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
}

const INFORMATIONAL_PREFIX = /^(?:объясни|расскажи|почему|что такое|можно ли|как (?:мне |нам )?(?:сделать|создать|настроить|установить)|explain|describe|why|what is|how (?:do|can|should|to)\b)/i
// JavaScript's `\b` is ASCII-centric: it does not form reliable boundaries
// around Cyrillic words. Keep Russian alternatives explicit, and use `\b`
// only inside the English-only branches.
const DELEGATE_RE = /(?:делегируй|делегировать|субагент(?:у|ам|а|ы)?|параллельн(?:ый|ые|о) агент)|\b(?:subagents?|spawn (?:a )?subagent|delegate (?:this )?to|parallel agents?)\b/i
const INSPECT_RE = /(?:проверь|проверить|посмотри|изучи|изучить|проанализируй|найди|покажи|прочитай|сверь|протестируй|запусти тесты)|\b(?:inspect|check|verify|analy[sz]e|find|show|read|list|run (?:the )?tests?)\b/i
const MUTATE_RE = /(?:создай|добавь|измени|исправь|обнови|удали|запусти|установи|настрой|отправь|сохрани|перенеси|реализуй|доработай|почини)|\b(?:create|add|change|edit|fix|update|delete|remove|run|install|configure|send|save|move|implement)\b/i
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
  if (DELEGATE_RE.test(text)) return { kind: 'delegate-required', reasonCode: 'DELEGATE_VERB' }
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
    return delegated
      ? { satisfied: true, missing: 'none' }
      : { satisfied: false, missing: 'delegation' }
  }

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

export function actionRecoveryInstruction(
  contract: ActionContract,
  verdict: ActionContractVerdict,
): string {
  return [
    `Action contract: ${contract.kind}.`,
    `Missing evidence: ${verdict.missing}.`,
    'Do not claim completion. Call a relevant tool now; after a mutation, independently verify the postcondition.',
  ].join(' ')
}
