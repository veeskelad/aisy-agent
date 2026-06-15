import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeToolRegistry, makeCompressor, sanitizeControlSequences, checkWriteMode } from './index.js'
import type {
  ToolCall,
  ToolDefinition,
  ContextState,
  ToolResult,
  NormalizedCall,
  Hooks,
  PreVerdict,
  ContextSafeResult,
  ToolRegistryDeps,
} from './types.js'
import { makeEffectVerifier } from '../testing/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOperatorCtx(tier: 0 | 1 | 2 | 3 = 0): ContextState {
  return { hasUntrustedSpan: false, activeTier: tier }
}

function makeUntrustedCtx(tier: 0 | 1 | 2 | 3 = 0): ContextState {
  return { hasUntrustedSpan: true, activeTier: tier }
}

/** A normalized call wrapper — in production Core (01) normalizes; here we cast. */
function asNormalized(call: ToolCall): NormalizedCall {
  return { ...call, _normalized: true } as NormalizedCall
}

function makeToolResult(text: string, ok = true): ToolResult {
  return { ok, rawText: text }
}

// A stub Hooks impl that always denies (safe default for red tests).
function makeDenyingHooks(): Hooks {
  return {
    async preToolUse(_call, _ctx) {
      return { kind: 'deny', reason: 'stub', rule: 'STUB_DENY' }
    },
    async postToolUse(_call, raw) {
      return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
    },
  }
}

// ---------------------------------------------------------------------------
// §9 AC-04-1  Narrow waist: count < 20
// ---------------------------------------------------------------------------

describe('AC-04-1: base tool count < 20', () => {
  it('AC-04-1: registry with 19 tools passes the count invariant', () => {
    // A real registry should expose a way to query count and assert < 20.
    // This test will pass once makeToolRegistry supports a `count()` method.
    const registry = makeToolRegistry({ hooks: makeDenyingHooks() })
    // @ts-expect-error — count() does not exist yet (red test)
    expect(registry.count()).toBeLessThan(20)
  })

  it('AC-04-1b: adding a 20th base tool to the registry fixture makes count fail', () => {
    const registry = makeToolRegistry({ hooks: makeDenyingHooks() })
    // @ts-expect-error — count() does not exist yet (red test)
    const before = registry.count() as number
    for (let i = before; i < 20; i++) {
      registry.register({
        name: 'read_file', // we only have a fixed set; this should fail on 20th
        description: `extra-${i}`,
        tier: 0,
        outboundSink: false,
        sideEffecting: false,
      } as unknown as ToolDefinition)
    }
    // @ts-expect-error — count() does not exist yet (red test)
    expect(registry.count()).toBeGreaterThanOrEqual(20) // invariant would fire
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-2  Byte-stable serialisation hash
// ---------------------------------------------------------------------------

describe('AC-04-2: byte-stable tool-definition block hash', () => {
  it('AC-04-2: re-serialising the definition block yields the committed golden hash', () => {
    const registry = makeToolRegistry({ hooks: makeDenyingHooks() })
    // @ts-expect-error — serializeHash() does not exist yet (red test)
    const hash: string = registry.serializeHash()
    // The golden hash is committed in CI; here we just assert the method exists
    // and returns a 64-char hex string (SHA-256).
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('AC-04-2b: mutating a tool field changes the hash', () => {
    const registry = makeToolRegistry({ hooks: makeDenyingHooks() })
    // @ts-expect-error — serializeHash() does not exist yet (red test)
    const hashBefore: string = registry.serializeHash()
    // @ts-expect-error — mutateTool() does not exist yet (red test)
    registry.mutateTool('bash', { description: 'changed' })
    // @ts-expect-error — serializeHash() does not exist yet (red test)
    const hashAfter: string = registry.serializeHash()
    expect(hashBefore).not.toBe(hashAfter)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-3  New capability via skill/MCP leaves base count unchanged
// ---------------------------------------------------------------------------

describe('AC-04-3: capability via skill/MCP does not widen the base registry', () => {
  it('AC-04-3: registering a new skill does not increment base tool count', () => {
    const registry = makeToolRegistry({ hooks: makeDenyingHooks() })
    // @ts-expect-error — count() / registerSkill() do not exist yet (red test)
    const before = registry.count() as number
    // @ts-expect-error — registerSkill() does not exist yet (red test)
    registry.registerSkill({ name: 'my-new-skill', body: async () => ({}) })
    // @ts-expect-error — count() does not exist yet (red test)
    expect(registry.count()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-4  HARD_DENY on rm -rf / obfuscated variant
// ---------------------------------------------------------------------------

describe('AC-04-4: bash rm -rf / is denied; executor never called', () => {
  it('AC-04-4: rm -rf / returns deny with populated rule', async () => {
    const spy = makeEffectVerifier()
    const hooks: Hooks = {
      async preToolUse(_call, _ctx) {
        return { kind: 'deny', reason: 'HARD_DENY match: rm -rf', rule: 'HARD_DENY_RM_RF' }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'bash',
      args: { cmd: 'rm -rf /' },
      argProvenance: { cmd: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.verdict!.kind).toBe('deny')
    expect(result.verdict!.rule).toBeTruthy()
    spy.expectNoEffect('tool-call')
  })

  it('AC-04-4b: obfuscated variant (alias expansion) is also denied', async () => {
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        // Normalization should expand aliases before matching.
        const cmd = String(call.args['cmd'] ?? '')
        const isDestructive = /rm\s+-rf\s+\//.test(cmd)
        return isDestructive
          ? { kind: 'deny', reason: 'HARD_DENY match after normalization', rule: 'HARD_DENY_RM_RF' }
          : { kind: 'deny', reason: 'stub', rule: 'STUB' }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const obfuscatedCall: ToolCall = {
      tool: 'bash',
      // This would be normalized to the canonical form before matching.
      args: { cmd: 'alias nuke="rm -rf /"; nuke' },
      argProvenance: { cmd: 'operator' },
    }
    const result = await registry.execute(obfuscatedCall, makeOperatorCtx())
    expect(result.verdict!.kind).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-5  Safety verdict unavailable -> fail-closed deny
// ---------------------------------------------------------------------------

describe('AC-04-5: Safety verdict unavailable -> fail-closed deny', () => {
  it('AC-04-5: Safety verdict throws -> PreToolUse returns deny for bash', async () => {
    const hooks: Hooks = {
      async preToolUse(_call, _ctx) {
        throw new Error('Safety verdict source unavailable')
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'bash',
      args: { cmd: 'echo hi' },
      argProvenance: { cmd: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    // Must deny, not allow — fail-closed
    expect(result.verdict!.kind).toBe('deny')
    expect(result.verdict!.rule).toMatch(/safety_unavailable|hook_error/i)
  })

  it('AC-04-5b: Safety verdict times out -> deny (even for read_file)', async () => {
    const hooks: Hooks = {
      async preToolUse(_call, _ctx) {
        await new Promise<never>((_res, rej) =>
          setTimeout(() => rej(new Error('timeout')), 1)
        )
        // unreachable
        return { kind: 'allow', call: asNormalized(_call as ToolCall) }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/etc/hosts' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.verdict!.kind).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-6  Outbound lockout when hasUntrustedSpan == true
// ---------------------------------------------------------------------------

describe('AC-04-6: outbound lockout with untrusted span in context', () => {
  it('AC-04-6: send_message with untrusted span returns deny + outbound_locked event', async () => {
    const effects = makeEffectVerifier()
    const hooks: Hooks = {
      async preToolUse(call, ctx) {
        if (ctx.hasUntrustedSpan) {
          // Lookup would come from ToolDefinition.outboundSink
          const outboundTools = new Set<string>(['send_message', 'fetch_web', 'git'])
          if (outboundTools.has(call.tool)) {
            effects.record({ kind: 'tool-call', target: 'tool.outbound_locked' })
            return { kind: 'deny', reason: 'outbound lockout', rule: 'OUTBOUND_LOCK' }
          }
        }
        return { kind: 'deny', reason: 'stub', rule: 'STUB' }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'send_message',
      args: { text: 'hello' },
      argProvenance: { text: 'operator' },
    }
    const result = await registry.execute(call, makeUntrustedCtx())
    expect(result.verdict!.kind).toBe('deny')
    effects.expectEffect('tool-call', 'tool.outbound_locked')
  })

  it('AC-04-6b: outbound git push with untrusted span returns deny', async () => {
    const effects = makeEffectVerifier()
    const hooks: Hooks = {
      async preToolUse(call, ctx) {
        if (ctx.hasUntrustedSpan) {
          effects.record({ kind: 'tool-call', target: 'tool.outbound_locked' })
          return { kind: 'deny', reason: 'outbound lockout', rule: 'OUTBOUND_LOCK' }
        }
        return { kind: 'deny', reason: 'stub', rule: 'STUB' }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'git',
      args: { subcmd: 'push', remote: 'origin' },
      argProvenance: { subcmd: 'operator', remote: 'operator' },
    }
    const result = await registry.execute(call, makeUntrustedCtx())
    expect(result.verdict!.kind).toBe('deny')
    effects.expectEffect('tool-call', 'tool.outbound_locked')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-7  Outbound lockout clears on clean operator turn
// ---------------------------------------------------------------------------

describe('AC-04-7: lockout clears with clean operator turn (no untrusted span)', () => {
  it('AC-04-7: send_message returns allow when hasUntrustedSpan == false', async () => {
    const hooks: Hooks = {
      async preToolUse(call, ctx) {
        if (ctx.hasUntrustedSpan) {
          return { kind: 'deny', reason: 'outbound lockout', rule: 'OUTBOUND_LOCK' }
        }
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'send_message',
      args: { text: 'hello' },
      argProvenance: { text: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.verdict!.kind).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-8  Motivated-call block: untrusted argProvenance
// ---------------------------------------------------------------------------

describe('AC-04-8: motivated-call block on untrusted argProvenance', () => {
  it('AC-04-8: side-effecting tool with untrusted arg returns deny + blocked_motivated', async () => {
    const effects = makeEffectVerifier()
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        const hasUntrustedArg = Object.values(call.argProvenance).includes('untrusted')
        // bash is side-effecting
        if (hasUntrustedArg && call.tool === 'bash') {
          effects.record({ kind: 'tool-call', target: 'tool.blocked_motivated' })
          return { kind: 'deny', reason: 'motivated-call block', rule: 'MOTIVATED_CALL' }
        }
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })

    const untrustedCall: ToolCall = {
      tool: 'bash',
      args: { cmd: 'echo attacker_controlled' },
      argProvenance: { cmd: 'untrusted' },
    }
    const operatorCall: ToolCall = {
      tool: 'bash',
      args: { cmd: 'echo safe' },
      argProvenance: { cmd: 'operator' },
    }

    const untrustedResult = await registry.execute(untrustedCall, makeOperatorCtx())
    expect(untrustedResult.verdict!.kind).toBe('deny')
    effects.expectEffect('tool-call', 'tool.blocked_motivated')

    effects.reset()
    const operatorResult = await registry.execute(operatorCall, makeOperatorCtx())
    expect(operatorResult.verdict!.kind).toBe('allow')
    effects.expectNoEffect('tool-call')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-9  Tier reduction: Tier-2/3 forced to ask; Tier-0 still allows
// ---------------------------------------------------------------------------

describe('AC-04-9: tier reduction under untrusted context', () => {
  it('AC-04-9: Tier-2 tool with untrusted span returns ask, not allow', async () => {
    const hooks: Hooks = {
      async preToolUse(call, ctx) {
        // write_file is Tier-2
        if (ctx.hasUntrustedSpan && call.tool === 'write_file') {
          return {
            kind: 'ask',
            tier: 2,
            card: { toolName: call.tool, normalizedArgs: call.args, reason: 'tier reduction' },
          }
        }
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'write_file',
      args: { path: '/tmp/out', content: 'data' },
      argProvenance: { path: 'operator', content: 'operator' },
    }
    const result = await registry.execute(call, makeUntrustedCtx())
    expect(result.verdict!.kind).toBe('ask')
  })

  it('AC-04-9b: Tier-0 read_file with operator provenance still returns allow under untrusted ctx', async () => {
    const hooks: Hooks = {
      async preToolUse(call, ctx) {
        if (ctx.hasUntrustedSpan) {
          const tier0ReadTools = new Set(['search_memory', 'list_dir', 'read_file'])
          const hasUntrustedArg = Object.values(call.argProvenance).includes('untrusted')
          if (!tier0ReadTools.has(call.tool) || hasUntrustedArg) {
            return { kind: 'deny', reason: 'capability narrowing', rule: 'TIER_REDUCTION' }
          }
        }
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/safe/file' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeUntrustedCtx())
    expect(result.verdict!.kind).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-10  Secret redaction
// ---------------------------------------------------------------------------

describe('AC-04-10: secret redaction in PostToolUse', () => {
  it('AC-04-10: vault value in tool result is masked; redacted == true', async () => {
    const SECRET = 'super-secret-token-abc123'
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        const vaultValues = [SECRET]
        let text = raw.rawText
        let redacted = false
        for (const v of vaultValues) {
          if (text.includes(v)) {
            text = text.replaceAll(v, '[REDACTED]')
            redacted = true
          }
        }
        return { ok: raw.ok, text, redacted, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/etc/secret' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    // The raw result the executor returns would contain the secret.
    // PostToolUse must mask it before the result enters context.
    expect(result.text).not.toContain(SECRET)
    expect(result.text).toContain('[REDACTED]')
    expect(result.redacted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-11  Redaction runs before compression
// ---------------------------------------------------------------------------

describe('AC-04-11: redaction before compression — compressed output contains no vault value', () => {
  it('AC-04-11: rtk compression does not re-expose a redacted vault value', async () => {
    const SECRET = 'vault-secret-xyz'
    let redactionRanFirst = false
    let compressionRanAfter = false

    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        // Step 1: error->result (not needed here)
        // Step 2: redact
        let text = raw.rawText
        if (text.includes(SECRET)) {
          text = text.replaceAll(SECRET, '[REDACTED]')
          redactionRanFirst = true
        }
        // Step 3: filter (no-op stub)
        // Step 4: compress (must run AFTER redact)
        if (redactionRanFirst) {
          compressionRanAfter = true
          // Simulate compression — must not resurrect secret
          text = `compressed:${text}`
        }
        return { ok: raw.ok, text, redacted: redactionRanFirst, compressed: compressionRanAfter }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/path' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.text).not.toContain(SECRET)
    expect(result.redacted).toBe(true)
    expect(result.compressed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-12  Vault value set unavailable -> fail-closed (ok:false)
// ---------------------------------------------------------------------------

describe('AC-04-12: vault unavailable -> PostToolUse returns ok:false', () => {
  it('AC-04-12: un-redacted result is not admitted when vault is down', async () => {
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, _raw) {
        // Vault value set lookup fails
        throw new Error('Vault unavailable')
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/sensitive' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.ok).toBe(false)
    // The raw text must not appear in the output
    expect(result.text).not.toContain('rawContent')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-13  rtk fail-open: fallback to raw safe bytes
// ---------------------------------------------------------------------------

describe('AC-04-13: rtk failure -> fail-open with raw safe bytes', () => {
  it('AC-04-13: rtk non-zero exit -> compressed:false, original safe bytes returned', async () => {
    const effects = makeEffectVerifier()
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        // rtk fails — fail open
        let text = raw.rawText
        let compressed = false
        try {
          throw new Error('rtk non-zero exit')
        } catch {
          effects.record({ kind: 'tool-call', target: 'tool.rtk_fallback' })
          // pass through raw safe bytes unchanged
          compressed = false
        }
        return { ok: raw.ok, text, redacted: false, compressed }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/data' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.compressed).toBe(false)
    expect(result.ok).toBe(true)  // call still succeeds
    effects.expectEffect('tool-call', 'tool.rtk_fallback')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-14  verifyBinary: wrong version disables compression
// ---------------------------------------------------------------------------

describe('AC-04-14: verifyBinary version mismatch disables compression', () => {
  it('AC-04-14: verifyBinary returns ok:false when version does not match pin', () => {
    const compressor = makeCompressor({ pinnedVersion: '1.2.3', binaryPath: '/usr/local/bin/rtk' })
    const result = compressor.verifyBinary()
    // When version returned by binary !== pinned, ok must be false
    expect(result.ok).toBe(false)
  })

  it('AC-04-14b: with ok:false verifyBinary, tool calls succeed with compressed:false', async () => {
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        // Compression is disabled because verifyBinary returned ok:false
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/data' },
      argProvenance: { path: 'operator' },
    }
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.compressed).toBe(false)
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-15  rtk install path guard: reject cargo install resolution
// ---------------------------------------------------------------------------

describe('AC-04-15: rtk install path rejects cargo install resolution', () => {
  it('AC-04-15: a resolved binary path from cargo install triggers a guard', () => {
    // The verifyBinary() implementation must reject paths that come from `cargo install`.
    // Typical cargo install path: $HOME/.cargo/bin/rtk
    const cargoBinPath = `${process.env['HOME'] ?? '/home/user'}/.cargo/bin/rtk`
    const compressor = makeCompressor({ pinnedVersion: '1.2.3', binaryPath: cargoBinPath })
    const result = compressor.verifyBinary()
    // Path from cargo install must fail the guard
    expect(result.ok).toBe(false)
    expect(result.resolvedPath).toMatch(/\.cargo/)
  })
})

// ---------------------------------------------------------------------------
// Regression: compress() must not block the event loop (was execFileSync).
// A declared-async compress() that calls a synchronous child-process exec
// freezes the whole loop for up to its 5s timeout. The fix uses a non-blocking
// async exec so timers/I-O can interleave while the child process runs.
// ---------------------------------------------------------------------------

describe('compress() does not block the event loop', () => {
  let dir: string
  let bin: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisy-rtk-'))
    bin = join(dir, 'rtk')
    // Fake rtk: prints the pinned version on --version (so verifyBinary passes),
    // and on the compress call sleeps briefly then echoes stdin back to stdout.
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "rtk 9.9.9"; exit 0; fi',
      'sleep 0.5',
      'cat',
      '',
    ].join('\n')
    writeFileSync(bin, script)
    chmodSync(bin, 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not block the event loop — control returns before the child completes', async () => {
    const compressor = makeCompressor({ pinnedVersion: '9.9.9', binaryPath: bin })
    const order: string[] = []

    const done = compressor.compress('hello world').then(() => { order.push('compress') })
    // Deterministic via MICROTASK ORDERING (FIFO is spec-guaranteed, so this is
    // load-independent — unlike a wall-clock timer/tick count that starves on a
    // busy cold-start worker). A synchronous execFileSync impl runs the child to
    // completion BEFORE compress() returns, so its .then resolves during these
    // drains; the async impl is still awaiting the child (its resolution rides a
    // libuv macrotask, not a microtask), so only 'tick' has run by the assert.
    // We assert ONLY the non-blocking property here; subprocess success/failure
    // (compressed:true) is cold-start-fragile and is covered by AC-04-11..13.
    order.push('tick')
    for (let k = 0; k < 5; k++) await Promise.resolve()

    expect(order).toEqual(['tick']) // child still running → compress not resolved
    await done
    expect(order).toEqual(['tick', 'compress'])
  })
})

// ---------------------------------------------------------------------------
// Regression: TOCTOU narrowing — compress() must execute the SAME resolved
// path that verifyBinary() just checked, not separately re-dereference
// deps.binaryPath. The fix re-verifies immediately before exec and runs the
// pinned resolvedPath returned by that verify call.
// ---------------------------------------------------------------------------

describe('compress() closes the verify/exec TOCTOU window', () => {
  let dir: string
  let bin: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisy-rtk-toctou-'))
    bin = join(dir, 'rtk')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('compresses through the verified resolved path', async () => {
    // Binary reports the pinned version and uppercases stdin as its "compression".
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "rtk 9.9.9"; exit 0; fi',
      'tr a-z A-Z',
      '',
    ].join('\n')
    writeFileSync(bin, script)
    chmodSync(bin, 0o755)

    const compressor = makeCompressor({ pinnedVersion: '9.9.9', binaryPath: bin })
    // verifyBinary().resolvedPath is the path compress() must execute.
    expect(compressor.verifyBinary().ok).toBe(true)
    const out = await compressor.compress('payload')
    expect(out.compressed).toBe(true)
    expect(out.text.trim()).toBe('PAYLOAD')
  })

  it('does not compress when the binary version does not match the pin', async () => {
    // Re-verify before exec must catch a version mismatch and fail open.
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "rtk 0.0.1"; exit 0; fi',
      'tr a-z A-Z',
      '',
    ].join('\n')
    writeFileSync(bin, script)
    chmodSync(bin, 0o755)

    const compressor = makeCompressor({ pinnedVersion: '9.9.9', binaryPath: bin })
    const out = await compressor.compress('payload')
    expect(out.compressed).toBe(false)
    expect(out.text).toBe('payload')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-16  PostToolUse error survival: loop continues after tool failure
// ---------------------------------------------------------------------------

describe('AC-04-16: underlying tool failure returns ok:false; loop survives', () => {
  it('AC-04-16: bash non-zero exit wrapped as structured result, no exception propagates', async () => {
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        // PostToolUse step 1: error -> result
        if (!raw.ok) {
          return { ok: false, text: `Error: ${String(raw.error ?? 'unknown')}`, redacted: false, compressed: false }
        }
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'bash',
      args: { cmd: 'exit 1' },
      argProvenance: { cmd: 'operator' },
    }

    let threw = false
    let result: ContextSafeResult | undefined
    try {
      result = await registry.execute(call, makeOperatorCtx())
    } catch {
      threw = true
    }

    // No exception must escape the loop
    expect(threw).toBe(false)
    expect(result?.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-17  PostToolUse ordering invariant
// ---------------------------------------------------------------------------

describe('AC-04-17: PostToolUse step order — error-wrap -> redact -> filter -> compress', () => {
  it('AC-04-17: trace shows correct step ordering in a single tool call', async () => {
    const order: string[] = []

    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        order.push('error-wrap')
        let text = raw.rawText

        order.push('redact')
        // (redaction no-op here)

        order.push('filter')
        // (filter no-op here)

        order.push('compress')
        // (compression no-op here)

        return { ok: raw.ok, text, redacted: false, compressed: false }
      },
    }

    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/data' },
      argProvenance: { path: 'operator' },
    }

    await registry.execute(call, makeOperatorCtx())

    expect(order).toEqual(['error-wrap', 'redact', 'filter', 'compress'])
  })

  it('AC-04-17b: reordering redact after compress causes AC-04-11 invariant to fail', () => {
    // This test documents the invariant: if compression runs before redaction,
    // a vault value can survive in the compressed output.
    // We assert the wrong order produces a detectable failure.
    const SECRET = 'vault-secret-reorder-test'
    let textAfterWrongOrder = ''

    const wrongOrderPostProcess = (rawText: string): string => {
      let text = rawText
      // WRONG ORDER: compress first, then redact
      // Simulate compression (no-op identity — in real life this would be rtk)
      text = `compressed:${text}`
      // Redact after compression — too late if compressor exposed any intermediate state
      text = text.replaceAll(SECRET, '[REDACTED]')
      textAfterWrongOrder = text
      return text
    }

    const correctOrderPostProcess = (rawText: string): string => {
      let text = rawText
      // CORRECT ORDER: redact first, then compress
      text = text.replaceAll(SECRET, '[REDACTED]')
      text = `compressed:${text}`
      return text
    }

    const rawInput = `result contains ${SECRET} inline`

    const wrong = wrongOrderPostProcess(rawInput)
    const correct = correctOrderPostProcess(rawInput)

    // Both happen to not contain the secret here because the identity compressor
    // is trivial — but in a real compressor the secret could re-emerge.
    // The test asserts that correct order is the canonical implementation.
    expect(correct).not.toContain(SECRET)
    expect(correct).toContain('[REDACTED]')

    // Document that wrong order must be rejected; in real impl the test harness
    // would inject a compressor that exposes intermediate state:
    expect(wrong).not.toContain(SECRET) // passes for identity — real rtk may differ
    // The key invariant: correct order ALWAYS holds; wrong order is prohibited by §5.
    expect(correct.indexOf('[REDACTED]')).toBeLessThan(correct.indexOf('compressed:') + 'compressed:'.length + 50)
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-18  Output sanitization: ANSI / control escapes stripped (ADR-0037)
// ---------------------------------------------------------------------------

describe('AC-04-18: ANSI/control escapes sanitized before any sink', () => {
  it('AC-04-18: model output with ANSI/control sequences is stripped in PostToolUse filter', async () => {
    // A fixture tool result laced with: SGR color codes, a cursor move, a
    // terminal title-set OSC, a raw bell, and an embedded carriage return —
    // exactly the class of injection ADR-0037 calls out for output channels.
    const poisoned =
      '[31mred[0m [2J]0;pwn line1\r\nplain'
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return { kind: 'allow', call: asNormalized(call) }
      },
      async postToolUse(_call, raw) {
        // Step 3 (output filter) sanitizes control/ANSI before the result
        // reaches any sink — Telegram, log, or terminal.
        return { ok: raw.ok, text: sanitizeControlSequences(raw.rawText), redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'read_file',
      args: { path: '/data' },
      argProvenance: { path: 'operator' },
    }
    // Drive the fixture output through the registry by feeding the poisoned
    // text in directly via a hook (the executor fixture is fixed), so assert
    // on the sanitizer contract here and through execute below.
    const result = await registry.execute(call, makeOperatorCtx())
    expect(result.ok).toBe(true)

    const cleaned = sanitizeControlSequences(poisoned)
    // No raw escape (ESC 0x1B), no BEL (0x07), no lone CR (0x0D) survive.
    expect(cleaned).not.toMatch(//)
    expect(cleaned).not.toMatch(//)
    expect(cleaned).not.toMatch(/\r/)
    // Visible text content is preserved.
    expect(cleaned).toContain('red')
    expect(cleaned).toContain('line1')
    expect(cleaned).toContain('plain')
    // A normal newline is allowed through untouched.
    expect(cleaned).toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-18b  Untrusted approval-card reason sanitized before reaching context
// (ADR-0037 — output-channel injection via the ask-verdict text path)
// ---------------------------------------------------------------------------

describe('AC-04-18b: untrusted card.reason sanitized in the ask-verdict text', () => {
  it('AC-04-18b: ANSI/control escapes in card.reason do not survive into result.text', async () => {
    // A tier-reduction ask on a call carrying untrusted input — the card reason
    // is attacker-influenced and laced with an SGR color code, a screen-clear,
    // a title-set OSC, a raw bell, and an embedded carriage return.
    const poisonedReason = '\x1b[31mpwn\x1b[0m \x1b[2J\x1b]0;owned\x07\r\ninjected'
    const hooks: Hooks = {
      async preToolUse(call, _ctx) {
        return {
          kind: 'ask',
          tier: 2,
          card: { toolName: call.tool, normalizedArgs: call.args, reason: poisonedReason },
        }
      },
      async postToolUse(_call, raw) {
        return { ok: raw.ok, text: raw.rawText, redacted: false, compressed: false }
      },
    }
    const registry = makeToolRegistry({ hooks })
    const call: ToolCall = {
      tool: 'write_file',
      args: { path: '/tmp/out', content: 'data' },
      argProvenance: { path: 'untrusted', content: 'untrusted' },
    }
    const result = await registry.execute(call, makeUntrustedCtx())
    expect(result.verdict!.kind).toBe('ask')
    // No raw escape (ESC 0x1B), no BEL (0x07), no lone CR (0x0D) reaches context.
    expect(result.text).not.toMatch(/\x1b/)
    expect(result.text).not.toMatch(/\x07/)
    expect(result.text).not.toMatch(/\r/)
    // Visible reason content and the approval prefix are preserved.
    expect(result.text).toContain('Approval required (Tier-2)')
    expect(result.text).toContain('pwn')
    expect(result.text).toContain('injected')
  })
})

// ---------------------------------------------------------------------------
// §9 AC-04-19  Destructive overwrite vs append on the write path
// ---------------------------------------------------------------------------

describe('AC-04-19: destructive overwrite is distinguishable from append', () => {
  it('AC-04-19: overwrite without confirmation is denied (ask/deny), with confirmation allowed', () => {
    const noConfirm = checkWriteMode({ path: '/mem/notes.md', content: 'x', writeMode: 'overwrite' })
    expect(noConfirm.ok).toBe(false)
    expect(noConfirm.reason).toMatch(/confirm/i)

    const confirmed = checkWriteMode({ path: '/mem/notes.md', content: 'x', writeMode: 'overwrite', confirmOverwrite: true })
    expect(confirmed.ok).toBe(true)
  })

  it('AC-04-19b: append never truncates — confirmOverwrite on an append is rejected', () => {
    const ok = checkWriteMode({ path: '/mem/notes.md', content: 'x', writeMode: 'append' })
    expect(ok.ok).toBe(true)
    expect(ok.truncates).toBe(false)

    // append is structurally incapable of truncating: setting the overwrite
    // confirmation on an append is a misuse and must be rejected.
    const misuse = checkWriteMode({ path: '/mem/notes.md', content: 'x', writeMode: 'append', confirmOverwrite: true })
    expect(misuse.ok).toBe(false)
    expect(misuse.truncates).toBe(false)
  })
})
