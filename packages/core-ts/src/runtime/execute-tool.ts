// Tool executor (runtime).
//
// Maps an approved ToolCall to a real implementation via injected ports. This is
// the agent-loop's `executeTool` seam; it runs ONLY after hookGate.pre has
// allowed the call, so it is not a security boundary — but it still confines
// filesystem operations to the workspace as defense-in-depth. Side-effecting
// tools (bash) are injected ports so the sandbox stays swappable/testable.

import { isAbsolute, normalize, resolve } from 'node:path'
import type { ToolCall } from '../agent-loop/types.js'

export interface ToolResult {
  ok: boolean
  output: string
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
}

function arg(call: ToolCall, key: string): string {
  const v = call.args[key]
  return typeof v === 'string' ? v : ''
}

export function makeToolExecutor(
  deps: ExecuteToolDeps,
): (call: ToolCall) => Promise<ToolResult> {
  const root = resolve(deps.workspaceRoot)

  /** Resolve a tool-supplied path under the workspace root; null if it escapes. */
  const confine = (p: string): string | null => {
    if (p.length === 0) return null
    const abs = isAbsolute(p) ? normalize(p) : resolve(root, p)
    if (abs !== root && !abs.startsWith(root + '/')) return null
    return abs
  }

  return async (call: ToolCall): Promise<ToolResult> => {
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

      default:
        return { ok: false, output: `unsupported tool: ${call.name}` }
    }
  }
}
