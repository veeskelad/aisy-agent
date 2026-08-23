import type { ToolCall } from '../agent-loop/types.js'
import { ContextLeaseError, type TurnContextLease } from './context-lease.js'
import { ConfinementError, type ConfinementPort } from './confinement.js'
import type { ToolResult } from './execute-tool.js'

export interface LeaseBoundToolExecutorDeps {
  lease: TurnContextLease
  confinement: ConfinementPort
  fallback: (call: ToolCall) => Promise<ToolResult>
  runBash?: (
    lease: TurnContextLease,
    command: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

function arg(call: ToolCall, key: string): string {
  const value = call.args[key]
  return typeof value === 'string' ? value : ''
}

function safeCode(error: unknown): string {
  if (error instanceof ConfinementError || error instanceof ContextLeaseError) return error.code
  return 'FILE_TOOL_FAILED'
}

/**
 * Per-turn tool boundary. File operations always use the immutable context
 * lease; bash remains unavailable unless a root-only sandbox port is injected.
 */
export function makeLeaseBoundToolExecutor(
  deps: LeaseBoundToolExecutorDeps,
): (call: ToolCall) => Promise<ToolResult> {
  return async (call) => {
    try {
      switch (call.name) {
        case 'read_file':
          return {
            ok: true,
            output: await deps.confinement.readText(deps.lease, arg(call, 'path')),
          }
        case 'write_file': {
          const path = arg(call, 'path')
          const bytes = await deps.confinement.writeText(
            deps.lease,
            path,
            arg(call, 'content'),
          )
          return { ok: true, output: `wrote ${bytes} bytes` }
        }
        case 'edit_file': {
          const path = call.args['path']
          const oldText = call.args['oldText']
          const newText = call.args['newText']
          const replaceAll = call.args['replaceAll']
          if (typeof path !== 'string' || path.length === 0 ||
            typeof oldText !== 'string' || oldText.length === 0 ||
            typeof newText !== 'string' ||
            (replaceAll !== undefined && typeof replaceAll !== 'boolean')) {
            return { ok: false, output: 'edit_file: INVALID_ARGUMENTS' }
          }
          const result = await deps.confinement.editText(
            deps.lease,
            path,
            oldText,
            newText,
            { replaceAll: replaceAll === true },
          )
          return {
            ok: true,
            output: `edited ${result.replacements} occurrence(s); ${result.bytes} bytes`,
          }
        }
        case 'list_dir':
          return {
            ok: true,
            output: (await deps.confinement.list(deps.lease, arg(call, 'path') || '.')).join('\n'),
          }
        case 'bash': {
          if (!deps.runBash) return { ok: false, output: 'bash: root-only sandbox unavailable' }
          const result = await deps.runBash(deps.lease, arg(call, 'cmd'))
          const body = [result.stdout, result.stderr].filter((value) => value.length > 0).join('\n')
          return {
            ok: result.exitCode === 0,
            output: `${body}\n(exit ${result.exitCode})`.trim(),
          }
        }
        default:
          return await deps.fallback(call)
      }
    } catch (error) {
      return { ok: false, output: `${call.name}: ${safeCode(error)}` }
    }
  }
}
