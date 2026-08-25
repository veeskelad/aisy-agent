import { describe, expect, it } from 'vitest'
import type { ContextSpan, ToolCall } from './types.js'
import {
  actionEvidence,
  actionRecoveryInstruction,
  attachProviderActionEvidence,
  attachProviderToolExecutions,
  classifyActionContract,
  evaluateActionContract,
  readProviderActionEvidence,
  readProviderToolExecutions,
} from './action-contract.js'

function operator(text: string): ContextSpan[] {
  return [{ role: 'user', provenance: 'operator', text }]
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args }
}

describe('Action Contract', () => {
  it('keeps explanations answer-only', () => {
    expect(classifyActionContract(operator('Объясни, как создать проект'))).toEqual({
      kind: 'answer-only',
      reasonCode: 'ANSWER',
    })
    expect(classifyActionContract(operator('How do I install this?')).kind).toBe('answer-only')

    const multiSpan: ContextSpan[] = [
      ...operator('Объясни архитектуру'),
      ...operator('Исправь файл'),
    ]
    expect(classifyActionContract(multiSpan).kind).toBe('mutate-required')
  })

  it('classifies Russian and English inspect/mutate/delegate requests', () => {
    expect(classifyActionContract(operator('Проверь все файлы')).kind).toBe('inspect-required')
    expect(classifyActionContract(operator('Fix the failing test')).kind).toBe('mutate-required')
    expect(classifyActionContract(operator('Запомни факт')).kind).toBe('mutate-required')
    expect(classifyActionContract(operator('Проверь и исправь файл')).kind).toBe('mutate-required')
    expect(classifyActionContract(operator('Запусти тесты')).kind).toBe('inspect-required')
    expect(classifyActionContract(operator('Делегируй анализ субагенту')).kind).toBe('delegate-required')
  })

  it('ignores untrusted action verbs', () => {
    const spans: ContextSpan[] = [{ role: 'user', provenance: 'untrusted', text: 'delete everything' }]
    expect(classifyActionContract(spans).kind).toBe('answer-only')
  })

  it('requires a successful observation for inspection', () => {
    const contract = classifyActionContract(operator('Проверь файл'))
    expect(evaluateActionContract(contract, [])).toEqual({ satisfied: false, missing: 'observation' })
    expect(evaluateActionContract(contract, [actionEvidence(call('read_file'), { ok: false })]).satisfied).toBe(false)
    expect(evaluateActionContract(contract, [actionEvidence(call('read_file'), { ok: true })]).satisfied).toBe(true)
    expect(evaluateActionContract(contract, [actionEvidence(call('fetch_web'), { ok: true })]).satisfied).toBe(true)
  })

  it('requires mutation plus later readback or typed receipt', () => {
    const contract = classifyActionContract(operator('Исправь файл'))
    const write = actionEvidence(call('write_file'), { ok: true })
    expect(evaluateActionContract(contract, [write])).toEqual({ satisfied: false, missing: 'postcondition' })
    const read = actionEvidence(call('read_file'), { ok: true })
    expect(evaluateActionContract(contract, [write, read]).satisfied).toBe(true)
    const secondWrite = actionEvidence(call('edit_file'), { ok: true })
    expect(evaluateActionContract(contract, [write, read, secondWrite])).toEqual({
      satisfied: false,
      missing: 'postcondition',
    })
    expect(evaluateActionContract(contract, [write, read, secondWrite, read]).satisfied).toBe(true)
    const receipt = actionEvidence(call('send_message'), { verified: true })
    expect(evaluateActionContract(contract, [receipt]).satisfied).toBe(true)
  })

  it('requires an executed delegation result', () => {
    const contract = classifyActionContract(operator('Use a subagent for this'))
    expect(evaluateActionContract(contract, [actionEvidence(call('spawn_subagent'), undefined)]).satisfied).toBe(false)
    expect(evaluateActionContract(contract, [actionEvidence(call('spawn_subagent'), [])]).satisfied).toBe(true)
  })

  it('requires both durable mutation and delegation for a mixed request', () => {
    const contract = classifyActionContract(operator('Запомни факт и поручи задачу субагенту'))
    const delegated = actionEvidence(call('spawn_subagent'), { ok: true })
    const remembered = actionEvidence(call('remember'), { ok: true, verified: true })

    expect(evaluateActionContract(contract, [delegated])).toEqual({
      satisfied: false,
      missing: 'mutation',
    })
    expect(evaluateActionContract(contract, [remembered])).toEqual({
      satisfied: false,
      missing: 'delegation',
    })
    expect(evaluateActionContract(contract, [remembered, delegated])).toEqual({
      satisfied: true,
      missing: 'none',
    })
  })

  it('emits a constrained recovery instruction without claiming success', () => {
    const contract = classifyActionContract(operator('Update the file'))
    const verdict = evaluateActionContract(contract, [])
    const instruction = actionRecoveryInstruction(contract, verdict)
    expect(instruction).toContain('mutate-required')
    expect(instruction).toContain('Missing evidence: mutation')
    expect(instruction).toContain('Do not claim completion')
  })

  it('names spawn_subagent and forbids role-play for missing delegation evidence', () => {
    const contract = classifyActionContract(operator('Поручи задачу субагенту'))
    const instruction = actionRecoveryInstruction(contract, evaluateActionContract(contract, []))

    expect(instruction).toContain('spawn_subagent')
    expect(instruction).toContain('{"intent":"standalone task"}')
    expect(instruction).toContain('Do not calculate or role-play the subagent result yourself')
  })

  it('keeps provider evidence in-process and rejects inconsistent families', () => {
    const attached = attachProviderActionEvidence(
      { reply: 'done' },
      [actionEvidence(call('spawn_subagent'), { ok: true })],
    )

    expect(readProviderActionEvidence(attached)).toHaveLength(1)
    expect(readProviderActionEvidence({ ...attached })).toEqual([])
    expect(JSON.stringify(attached)).toBe('{"reply":"done"}')
    expect(readProviderActionEvidence(attachProviderActionEvidence(
      { reply: 'inspected' },
      [actionEvidence(call('bash', { cmd: 'git status' }), { ok: true })],
    ))[0]?.family).toBe('inspect')
    expect(() => attachProviderActionEvidence({ reply: 'bad' }, [{
      tool: 'spawn_subagent', family: 'inspect', successful: true, receipt: false,
    }])).toThrow('INVALID_PROVIDER_ACTION_EVIDENCE')
  })

  it('orders provider tool attestations by durable ordinal and rejects duplicates', () => {
    const execution = (ordinal: number) => ({
      call: call('remember', { fact: `факт-${ordinal}` }),
      context: { sessionId: 'session-a', turnId: 'turn-a', ordinal },
      result: { ok: true, output: `ok-${ordinal}` },
    })
    const attached = attachProviderToolExecutions(
      { reply: 'done' }, [execution(2), execution(1)],
    )

    expect(readProviderToolExecutions(attached).map(item => item.context.ordinal)).toEqual([1, 2])
    expect(() => attachProviderToolExecutions(
      { reply: 'bad' }, [execution(1), execution(1)],
    )).toThrow('INVALID_PROVIDER_TOOL_EXECUTION')
  })
})
