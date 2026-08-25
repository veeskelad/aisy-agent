// Tool executor (runtime).
//
// Maps an approved ToolCall to a real implementation via injected ports. This is
// the agent-loop's `executeTool` seam; it runs ONLY after hookGate.pre has
// allowed the call, so it is not a security boundary — but it still confines
// filesystem operations to the workspace as defense-in-depth. Side-effecting
// tools (bash) are injected ports so the sandbox stays swappable/testable.

import { isAbsolute, normalize, resolve } from 'node:path'
import type { ToolCall, ToolExecutionContext } from '../agent-loop/types.js'
import type { CommitResult, MemoryOp } from '../memory/index.js'
import type { TaskObservation } from '../orchestration/index.js'
import { validateRuntimeToolCall } from './tool-catalog.js'
import {
  makeMemoryRememberReceipt,
  parseRememberFactArgs,
  renderMemoryAcknowledgement,
  type VerifiedToolMutationReceipt,
} from './memory-receipt.js'

export interface ToolResult {
  ok: boolean
  output: string
  /** Code-owned durable postcondition; never inferred from model prose. */
  verified?: true
  /** Exact code-owned mutation proof. Free-form executors cannot mint it. */
  mutationReceipt?: VerifiedToolMutationReceipt
}

export interface FsPort {
  readFile(path: string): string
  writeFile(path: string, content: string): void
  listDir(path: string): string[]
  exists(path: string): boolean
}

export interface ExecuteToolDeps {
  fs: FsPort
  /** Workspace root; file paths are resolved under it and may not escape. */
  workspaceRoot: string
  /** Sandbox shell port (Safety 05). Absent ⇒ bash reports unavailable. */
  runBash?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Memory FTS read port. Absent ⇒ search_memory reports unavailable. */
  searchMemory?: (query: string) => Promise<string> | string
  /** Sub-agent delegation runner. Absent ⇒ spawn_subagent reports unavailable. */
  spawnSubagent?: (
    planJson: string,
    context?: ToolExecutionContext,
  ) => Promise<TaskObservation[]>
  /** Memory store — enables the `remember` tool. Absent ⇒ remember reports unavailable. */
  /** Narrow commit port for `remember`. Only the commit choke point is needed
   *  here, so the executor does not depend on a whole memory implementation. */
  memory?: {
    // `topic` is what the model says the fact is about. It never changes where
    // the fact is stored — it exists so the app can tell whether the agent has
    // actually met the operator, instead of counting facts of any kind.
    commit(op: MemoryOp, ctx: { withinSession: boolean; topic?: string }): Promise<CommitResult>
  }
  /** Task tracker (ADR-0081). Absent ⇒ track_task reports unavailable. */
  trackTask?: (input: { action: string; text?: string; id?: string }) => Promise<string>
  /**
   * Register a trigger the agent scheduled for itself (ADR-0037). Absent ⇒
   * set_trigger reports unavailable. The engine owns the binding, the budget
   * and the schedule; this port carries only what the model said.
   */
  setTrigger?: (input: {
    kind: string
    prompt: string
    when?: string
    cron?: string
    probe?: string
  }) => Promise<string>
  /**
   * Propose a goal to the operator (Tier-7). Absent ⇒ set_goal reports
   * unavailable. Nothing starts here: the port shows a card and the operator's
   * tap is what begins the work.
   */
  setGoal?: (input: { objective: string; mode?: string }) => Promise<string>
  /** Read one day of the daily journal (ADR-0079). Absent ⇒ read_journal reports unavailable. */
  readJournal?: (date: string) => Promise<string>
  /** Knowledge zone of the current scope (ADR-0075/0080). Absent ⇒ both tools report unavailable. */
  knowledge?: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<string>
  }
  /** Fetch a public URL and return its text. Absent ⇒ fetch_url reports unavailable. */
  fetchUrl?: (url: string) => Promise<string>
  /** Web search returning formatted results text. Absent ⇒ web_search reports unavailable. */
  webSearch?: (query: string) => Promise<string>
  /**
   * Hands a question to a read-only researcher and returns its report. Absent ⇒
   * deep_research reports unavailable — a build without delegation says so
   * rather than quietly degrading into one more search.
   */
  deepResearch?: (question: string, context?: ToolExecutionContext) => Promise<string>
  /**
   * Tools contributed by native extension hooks (ADR-0077). They are dispatched
   * only after every built-in name failed to match, so a hook can never shadow
   * a primitive of the narrow waist.
   */
  hookTools?: ReadonlyArray<{
    name: string
    execute(input: Record<string, unknown>): Promise<string>
  }>
}

function arg(call: ToolCall, key: string): string {
  const v = call.args[key]
  return typeof v === 'string' ? v : ''
}

export function makeToolExecutor(
  deps: ExecuteToolDeps,
): (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult> {
  const root = resolve(deps.workspaceRoot)
  const committedRememberReceipts = new Map<string, ToolResult>()

  /** Resolve a tool-supplied path under the workspace root; null if it escapes. */
  const confine = (p: string): string | null => {
    if (p.length === 0) return null
    const abs = isAbsolute(p) ? normalize(p) : resolve(root, p)
    if (abs !== root && !abs.startsWith(root + '/')) return null
    return abs
  }

  return async (call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> => {
    const validated = validateRuntimeToolCall(call)
    if (!validated.ok && validated.reason === 'unknown-tool') {
      // Not a primitive of the narrow waist — a hook may still own this name.
      // Hooks resolve last precisely so they cannot shadow a built-in.
      const hook = deps.hookTools?.find((tool) => tool.name === call.name)
      if (hook) {
        try {
          const output = await hook.execute({ ...call.args })
          return typeof output === 'string'
            ? { ok: true, output }
            : { ok: false, output: `${call.name}: invalid output` }
        } catch {
          // A hook failure is a tool failure, never a runtime crash, and its
          // internal error text never reaches the model.
          return { ok: false, output: `${call.name}: failed` }
        }
      }
    }
    if (!validated.ok) {
      return {
        ok: false,
        output: validated.reason === 'unknown-tool'
          ? `unsupported tool: ${call.name}`
          : `invalid tool call: ${call.name}`,
      }
    }
    switch (call.name) {
      case 'read_file': {
        const path = confine(arg(call, 'path'))
        if (!path) return { ok: false, output: 'read_file: path outside workspace' }
        if (!deps.fs.exists(path)) return { ok: false, output: `read_file: not found: ${path}` }
        return { ok: true, output: deps.fs.readFile(path) }
      }

      case 'write_file': {
        const path = confine(arg(call, 'path'))
        if (!path) return { ok: false, output: 'write_file: path outside workspace' }
        deps.fs.writeFile(path, arg(call, 'content'))
        return { ok: true, output: `wrote ${path}` }
      }

      case 'list_dir': {
        const path = confine(arg(call, 'path') || '.')
        if (!path) return { ok: false, output: 'list_dir: path outside workspace' }
        if (!deps.fs.exists(path)) return { ok: false, output: `list_dir: not found: ${path}` }
        return { ok: true, output: deps.fs.listDir(path).join('\n') }
      }

      case 'bash': {
        if (!deps.runBash) return { ok: false, output: 'bash: sandbox unavailable' }
        const r = await deps.runBash(arg(call, 'cmd'))
        const body = [r.stdout, r.stderr].filter((s) => s.length > 0).join('\n')
        return { ok: r.exitCode === 0, output: `${body}\n(exit ${r.exitCode})`.trim() }
      }

      case 'search_memory': {
        if (!deps.searchMemory) return { ok: false, output: 'search_memory: unavailable' }
        return { ok: true, output: await deps.searchMemory(arg(call, 'query')) }
      }

      case 'spawn_subagent': {
        if (!deps.spawnSubagent) return { ok: false, output: 'spawn_subagent: delegation not available' }
        const planArg = arg(call, 'plan')
        if (planArg.length === 0) return { ok: false, output: 'spawn_subagent: plan must be a JSON string' }
        const observations = await deps.spawnSubagent(planArg, context)
        return { ok: true, output: JSON.stringify(observations) }
      }

      case 'remember': {
        const input = parseRememberFactArgs(call.args)
        if (input === null) return { ok: false, output: 'remember: exactly one valid fact or text required' }
        const receipt = makeMemoryRememberReceipt(input, context)
        if (receipt === null) return { ok: false, output: 'remember: execution identity required' }
        const replay = committedRememberReceipts.get(receipt.receiptId)
        if (replay !== undefined) return replay
        if (!deps.memory) return { ok: false, output: 'remember: unavailable' }
        try {
          const r = await deps.memory.commit(
            { op: 'ADD', text: input.fact },
            { withinSession: true, ...(input.topic === undefined ? {} : { topic: input.topic }) },
          )
          if (r.status === 'COMMITTED') {
            const committed = Object.freeze<ToolResult>({
              ok: true,
              output: renderMemoryAcknowledgement(input.fact),
              verified: true,
              mutationReceipt: receipt,
            })
            committedRememberReceipts.set(receipt.receiptId, committed)
            return committed
          }
          if (r.status === 'BLOCKED') return { ok: false, output: 'Эта информация ранее удалена из памяти.' }
          if (r.status === 'ROUTED_TO_REVIEW') return { ok: true, output: 'Похоже на ранее удалённое — отправил на проверку.' }
          return { ok: false, output: `remember: unexpected status: ${r.status}` }
        } catch (err) {
          return { ok: false, output: `remember: ${err instanceof Error ? err.message : 'error'}` }
        }
      }

      case 'read_knowledge': {
        if (!deps.knowledge) return { ok: false, output: 'read_knowledge: unavailable' }
        return { ok: true, output: await deps.knowledge.read(arg(call, 'path')) }
      }

      case 'write_knowledge': {
        const content = arg(call, 'content')
        if (content.trim().length === 0) return { ok: false, output: 'write_knowledge: content required' }
        if (!deps.knowledge) return { ok: false, output: 'write_knowledge: unavailable' }
        return { ok: true, output: await deps.knowledge.write(arg(call, 'path'), content) }
      }

      case 'track_task': {
        if (!deps.trackTask) return { ok: false, output: 'track_task: unavailable' }
        const args = call.args as Record<string, unknown>
        const optional = (key: string): string | undefined =>
          typeof args[key] === 'string' ? args[key] : undefined
        const text = optional('text')
        const id = optional('id')
        return {
          ok: true,
          output: await deps.trackTask({
            action: arg(call, 'action'),
            ...(text === undefined ? {} : { text }),
            ...(id === undefined ? {} : { id }),
          }),
        }
      }

      case 'set_trigger': {
        if (!deps.setTrigger) return { ok: false, output: 'set_trigger: unavailable' }
        const args = call.args as Record<string, unknown>
        const optional = (key: string): string | undefined =>
          typeof args[key] === 'string' && args[key].length > 0 ? args[key] : undefined
        const prompt = arg(call, 'prompt')
        if (prompt.trim().length === 0) return { ok: false, output: 'set_trigger: prompt required' }
        const when = optional('when')
        const cron = optional('cron')
        const probe = optional('probe')
        return {
          ok: true,
          output: await deps.setTrigger({
            kind: arg(call, 'kind'),
            prompt,
            ...(when === undefined ? {} : { when }),
            ...(cron === undefined ? {} : { cron }),
            ...(probe === undefined ? {} : { probe }),
          }),
        }
      }

      case 'set_goal': {
        if (!deps.setGoal) return { ok: false, output: 'set_goal: unavailable' }
        const objective = arg(call, 'objective')
        if (objective.trim().length === 0) {
          return { ok: false, output: 'set_goal: objective required' }
        }
        const raw = (call.args as Record<string, unknown>)['mode']
        const mode = typeof raw === 'string' && raw.length > 0 ? raw : undefined
        return {
          ok: true,
          output: await deps.setGoal({
            objective,
            ...(mode === undefined ? {} : { mode }),
          }),
        }
      }

      case 'read_journal': {
        if (!deps.readJournal) return { ok: false, output: 'read_journal: unavailable' }
        return { ok: true, output: await deps.readJournal(arg(call, 'date')) }
      }

      case 'fetch_url': {
        if (!deps.fetchUrl) return { ok: false, output: 'fetch_url: unavailable' }
        return { ok: true, output: await deps.fetchUrl(arg(call, 'url')) }
      }

      case 'web_search': {
        if (!deps.webSearch) return { ok: false, output: 'web_search: unavailable' }
        return { ok: true, output: await deps.webSearch(arg(call, 'query')) }
      }

      case 'deep_research': {
        if (!deps.deepResearch) return { ok: false, output: 'deep_research: unavailable' }
        // The researcher sees none of this conversation, so an empty question
        // is not a thin request — it is no request at all.
        const question = arg(call, 'question').trim()
        if (question.length === 0) {
          return { ok: false, output: 'deep_research: нужен вопрос текстом' }
        }
        return { ok: true, output: await deps.deepResearch(question, context) }
      }

      case 'goal_done':
        // Tier-0 claim: no side effect. The orchestrator (Phase C) intercepts this
        // sentinel before it reaches here; this case ensures graceful handling in
        // any runner that reaches the base executor (e.g. sub-agents).
        return { ok: true, output: '__goal_done__' }

      default:
        return { ok: false, output: `unsupported tool: ${call.name}` }
    }
  }
}
