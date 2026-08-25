import { describe, expect, it, vi } from 'vitest'
import { makeToolExecutor, type FsPort } from './execute-tool.js'
import {
  RUNTIME_TOOL_CATALOG,
  runtimeProviderTools,
  runtimeToolMinimumTiers,
  validateRuntimeToolCall,
  RUNTIME_TOOL_NAMES,
  isRuntimeToolName,
  type RuntimeToolName,
} from './tool-catalog.js'
import type { BaseToolName } from '../tools/types.js'

const validRuntimeName: RuntimeToolName = 'read_file'
const validBaseName: BaseToolName = 'goal_done'
// @ts-expect-error — arbitrary provider-native names cannot widen the waist
const invalidRuntimeName: RuntimeToolName = 'arbitrary_plugin_tool'
// @ts-expect-error — the compat type is the same closed runtime-name union
const invalidBaseName: BaseToolName = 'arbitrary_plugin_tool'
void validRuntimeName
void validBaseName
void invalidRuntimeName
void invalidBaseName

const fs: FsPort = {
  readFile: () => 'ok',
  writeFile: vi.fn(),
  listDir: () => [],
  exists: () => true,
}

describe('единый runtime tool catalog', () => {
  it('имеет narrow-waist count и точный provider/executor набор', () => {
    const schemas = runtimeProviderTools()
    expect(RUNTIME_TOOL_CATALOG.length).toBeLessThan(20)
    expect(schemas.map(tool => tool.name)).toEqual(RUNTIME_TOOL_CATALOG.map(tool => tool.name))
    expect(Object.keys(runtimeToolMinimumTiers()).sort()).toEqual(
      schemas.map(tool => tool.name).sort(),
    )
    expect(new Set(schemas.map(tool => tool.name)).size).toBe(schemas.length)
    expect(Object.isFrozen(RUNTIME_TOOL_CATALOG[0])).toBe(true)
    expect(Object.isFrozen(RUNTIME_TOOL_CATALOG[0]!.input_schema)).toBe(true)
    expect(Object.isFrozen(RUNTIME_TOOL_NAMES)).toBe(true)
    expect(() => (RUNTIME_TOOL_NAMES as string[]).push('mutable-injection')).toThrow()
  })

  it('не допускает лишние, отсутствующие и неверно типизированные аргументы', () => {
    expect(validateRuntimeToolCall({ name: 'read_file', args: { path: 'a' } }).ok).toBe(true)
    expect(validateRuntimeToolCall({ name: 'read_file', args: {} }).ok).toBe(false)
    expect(validateRuntimeToolCall({ name: 'read_file', args: { path: 1 } }).ok).toBe(false)
    expect(validateRuntimeToolCall({ name: 'read_file', args: { path: 'a', extra: 'x' } }).ok).toBe(false)
    expect(validateRuntimeToolCall({ name: 'unknown', args: {} }).ok).toBe(false)
    expect(validateRuntimeToolCall({ name: 'remember', args: { fact: 'ты любишь чай' } }).ok)
      .toBe(true)
    expect(validateRuntimeToolCall({ name: 'remember', args: { text: 'legacy fact' } }).ok)
      .toBe(true)
    expect(validateRuntimeToolCall({ name: 'remember', args: {} }).ok).toBe(false)
    expect(validateRuntimeToolCall({
      name: 'remember', args: { fact: 'one', text: 'two' },
    }).ok).toBe(false)
  })

  it('predicate narrows a string to the closed runtime-name union', () => {
    const candidate: string = 'read_file'
    expect(isRuntimeToolName(candidate)).toBe(true)
    if (isRuntimeToolName(candidate)) {
      const narrowed: RuntimeToolName = candidate
      expect(narrowed).toBe('read_file')
    }
    expect(isRuntimeToolName('arbitrary_plugin_tool')).toBe(false)
  })

  it('объясняет модели минимальный однозадачный формат делегирования', () => {
    const tool = runtimeProviderTools().find(item => item.name === 'spawn_subagent')

    expect(tool?.description).toContain('Required when the operator asks')
    expect(tool?.description).toContain('{"intent":"standalone task"}')
    expect(tool?.description).toContain('never imitate the sub-agent')
  })

  it('malformed call не вызывает ни один executor port', async () => {
    const readFile = vi.fn(() => 'not reached')
    const writeFile = vi.fn()
    const runBash = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const execute = makeToolExecutor({
      fs: { ...fs, readFile, writeFile },
      workspaceRoot: '/work',
      runBash,
    })

    await expect(execute({ name: 'read_file', args: {} })).resolves.toEqual({
      ok: false,
      output: 'invalid tool call: read_file',
    })
    expect(readFile).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    expect(runBash).not.toHaveBeenCalled()
  })

  it('каждое provider schema имя имеет executor dispatch case', async () => {
    const execute = makeToolExecutor({ fs, workspaceRoot: '/work' })
    const samples: Record<string, Record<string, string>> = {
      read_file: { path: 'a' },
      write_file: { path: 'a', content: 'x' },
      list_dir: {},
      bash: { cmd: 'true' },
      search_memory: { query: 'q' },
      remember: { fact: 'fact' },
      spawn_subagent: { plan: '{}' },
      goal_done: {},
      fetch_url: { url: 'https://example.test' },
      web_search: { query: 'q' },
    }
    for (const tool of runtimeProviderTools()) {
      const result = await execute({ name: tool.name, args: samples[tool.name]! })
      expect(result.output, tool.name).not.toContain(`unsupported tool: ${tool.name}`)
    }
  })
})
