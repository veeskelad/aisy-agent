import { describe, it, expect, vi } from 'vitest'
import { runCli, parseArgs, SETUP_ELEMENTS } from './index.js'
import type { OnboardingOps, DoctorReport, InitResult } from '../onboarding/index.js'

function report(over: Partial<DoctorReport> = {}): DoctorReport {
  return { ok: true, ranAt: '2026-06-13T00:00:00.000Z', harnessVersion: '0.0.0', checks: [], ...over }
}
function initResult(over: Partial<InitResult> = {}): InitResult {
  return { completed: true, outcomes: [], scaffolded: ['.env', 'SOUL.md'], ...over }
}

interface Cap { out: string[]; err: string[]; ops: OnboardingOps }
function makeCli(over: Partial<OnboardingOps> = {}): Cap & { run(argv: string[]): Promise<number> } {
  const out: string[] = []
  const err: string[] = []
  const ops: OnboardingOps = {
    init: vi.fn(async () => initResult()),
    doctor: vi.fn(async () => report()),
    toJson: (r) => JSON.stringify(r),
    diagnostics: vi.fn(async () => ({ bundlePath: '/tmp/aisy-diag.tgz', redactedFields: ['AISY_PROVIDER_KEY'] })),
    ...over,
  }
  return { out, err, ops, run: (argv) => runCli(argv, { ops, out: (s) => out.push(s), err: (s) => err.push(s), version: '0.0.0' }) }
}

describe('CLI router', () => {
  it('parseArgs splits command, boolean flags, --key=value, and lists', () => {
    const p = parseArgs(['doctor', '--fix', '--only=env,providers', '--out=/x'])
    expect(p.command).toBe('doctor')
    expect(p.flags['fix']).toBe(true)
    expect(p.flags['only']).toBe('env,providers')
    expect(p.flags['out']).toBe('/x')
  })

  it('`init --yes --non-interactive` dispatches with mapped opts and exits 0', async () => {
    const c = makeCli()
    const code = await c.run(['init', '--yes', '--non-interactive'])
    expect(c.ops.init).toHaveBeenCalledWith({ yes: true, force: false, nonInteractive: true })
    expect(code).toBe(0)
    expect(c.out.join('\n')).toMatch(/\.env/)
  })

  it('`init` that does not complete exits nonzero', async () => {
    const c = makeCli({ init: vi.fn(async () => initResult({ completed: false })) })
    expect(await c.run(['init'])).toBe(1)
  })

  it('`doctor` exits 0 when ok and 1 when not ok', async () => {
    expect(await makeCli({ doctor: vi.fn(async () => report({ ok: true })) }).run(['doctor'])).toBe(0)
    expect(await makeCli({ doctor: vi.fn(async () => report({ ok: false })) }).run(['doctor'])).toBe(1)
  })

  it('`doctor --json` prints the deterministic toJson output', async () => {
    const c = makeCli()
    await c.run(['doctor', '--json'])
    expect(c.out.join('')).toContain('"harnessVersion"')
  })

  it('`doctor --fix --post-upgrade --only=env,providers` maps flags to doctor opts', async () => {
    const c = makeCli()
    await c.run(['doctor', '--fix', '--post-upgrade', '--only=env,providers'])
    expect(c.ops.doctor).toHaveBeenCalledWith({ fix: true, postUpgrade: true, only: ['env', 'providers'] })
  })

  it('`diagnostics --out=/x` dispatches and prints the bundle path', async () => {
    const c = makeCli()
    const code = await c.run(['diagnostics', '--out=/x'])
    expect(c.ops.diagnostics).toHaveBeenCalledWith({ out: '/x' })
    expect(code).toBe(0)
    expect(c.out.join('\n')).toContain('/tmp/aisy-diag.tgz')
  })

  it('`--help` and no-command print usage and exit 0', async () => {
    const c1 = makeCli(); expect(await c1.run(['--help'])).toBe(0); expect(c1.out.join('\n')).toMatch(/aisy (init|doctor)/)
    const c2 = makeCli(); expect(await c2.run([])).toBe(0); expect(c2.out.join('\n')).toMatch(/aisy/)
  })

  it('an unknown command prints an error + usage and exits 2', async () => {
    const c = makeCli()
    const code = await c.run(['frobnicate'])
    expect(code).toBe(2)
    expect(c.err.join('\n')).toMatch(/unknown command/i)
  })

  it('USAGE contains both `run` and `setup` lines', async () => {
    const c = makeCli()
    await c.run(['--help'])
    const usage = c.out.join('\n')
    expect(usage).toMatch(/aisy run/)
    expect(usage).toMatch(/aisy setup/)
  })

  it('parseArgs([\'setup\',\'provider\']) yields {command:\'setup\', positional:[\'provider\']}', () => {
    const p = parseArgs(['setup', 'provider'])
    expect(p.command).toBe('setup')
    expect(p.positional).toEqual(['provider'])
  })

  it('`setup provider` routes to init and exits 0', async () => {
    const c = makeCli()
    const code = await c.run(['setup', 'provider'])
    expect(c.ops.init).toHaveBeenCalled()
    expect(code).toBe(0)
  })

  it('`setup` with no element routes to init and exits 0 (interactive)', async () => {
    const c = makeCli()
    const code = await c.run(['setup'])
    expect(c.ops.init).toHaveBeenCalled()
    expect(code).toBe(0)
  })

  it('`setup <unknown>` exits non-zero and names valid elements', async () => {
    const c = makeCli()
    const code = await c.run(['setup', 'nonsense'])
    expect(code).toBe(2)
    const errOut = c.err.join('\n')
    expect(errOut).toMatch(/nonsense/)
    for (const el of SETUP_ELEMENTS) {
      expect(errOut).toContain(el)
    }
  })

  it('SETUP_ELEMENTS contains provider, telegram, memory, personality', () => {
    expect(SETUP_ELEMENTS).toContain('provider')
    expect(SETUP_ELEMENTS).toContain('telegram')
    expect(SETUP_ELEMENTS).toContain('memory')
    expect(SETUP_ELEMENTS).toContain('personality')
  })

  it('`update` routes to ops.update, prints message, returns 0 when updated:true', async () => {
    const updateFn = vi.fn(async () => ({ updated: true, from: '0.0.0', message: 'Updated.' }))
    const c = makeCli({ update: updateFn })
    const code = await c.run(['update'])
    expect(updateFn).toHaveBeenCalledOnce()
    expect(c.out.join('')).toContain('Updated.')
    expect(code).toBe(0)
  })

  it('`update` returns 1 when updated:false', async () => {
    const c = makeCli({ update: vi.fn(async () => ({ updated: false, from: '0.0.0', message: 'Running from source.' })) })
    const code = await c.run(['update'])
    expect(code).toBe(1)
    expect(c.out.join('')).toContain('Running from source.')
  })

  it('`update` exits 2 and prints error when ops.update is absent', async () => {
    // Build a cli without update method
    const c = makeCli()
    // Remove update from ops
    const { update: _removed, ...opsWithoutUpdate } = c.ops as typeof c.ops & { update?: unknown }
    void _removed
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['update'], {
      ops: opsWithoutUpdate as typeof c.ops,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      version: '0.0.0',
    })
    expect(code).toBe(2)
    expect(err.join('')).toContain('update: not supported')
  })

  it('USAGE contains the `update` line', async () => {
    const c = makeCli()
    await c.run(['--help'])
    const usage = c.out.join('\n')
    expect(usage).toMatch(/aisy update/)
    expect(usage).toMatch(/latest published version/i)
  })
})
