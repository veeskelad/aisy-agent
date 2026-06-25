import type { OnboardingOps, DoctorReport, DoctorDomain } from '../onboarding/index.js'

// ---------------------------------------------------------------------------
// aisy CLI router — pure argv → command dispatch over OnboardingOps.
// Deterministic and side-effect-free except via injected out/err; the bin
// wrapper supplies real adapters + process.exit. (spec 13, ADR-0035)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string
  flags: Record<string, string | boolean>
  positional: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command = ''
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1)
      else flags[body] = true
    } else if (!command) {
      command = arg
    } else {
      positional.push(arg)
    }
  }
  return { command, flags, positional }
}

export interface CliDeps {
  ops: OnboardingOps
  out: (s: string) => void
  err: (s: string) => void
  version?: string
  /** Enable ANSI color in printReport output. Default: false. */
  color?: boolean
}

export const SETUP_ELEMENTS = ['provider', 'telegram', 'memory', 'personality'] as const
export type SetupElement = (typeof SETUP_ELEMENTS)[number]

const USAGE = `aisy — personal agent harness

Usage:
  aisy run                                          Boot the Telegram agent
  aisy init [--yes] [--force] [--non-interactive]   Scaffold & validate a config (idempotent)
  aisy setup [<element>]                            Re-run onboarding (optionally for one element)
  aisy doctor [--fix] [--json] [--post-upgrade]     Full-stack health check (read-only by default)
              [--only=a,b] [--skip=a,b]
  aisy diagnostics [--out=path]                     Write a redacted support bundle
  aisy update                                       Update to the latest published version
  aisy --help                                       Show this help`

const list = (v: string | boolean | undefined): DoctorDomain[] | undefined =>
  typeof v === 'string' && v.length > 0 ? (v.split(',') as DoctorDomain[]) : undefined

// ---------------------------------------------------------------------------
// Hermes-style colored doctor output.
// ---------------------------------------------------------------------------

function printReport(r: DoctorReport, out: (s: string) => void, color: boolean): void {
  // ANSI helpers — only emit escape codes when color is enabled.
  const green = (s: string): string => (color ? `\x1b[32m${s}\x1b[0m` : s)
  const red = (s: string): string => (color ? `\x1b[31m${s}\x1b[0m` : s)
  const yellow = (s: string): string => (color ? `\x1b[33m${s}\x1b[0m` : s)
  const dim = (s: string): string => (color ? `\x1b[2m${s}\x1b[0m` : s)

  const headline = r.ok ? green('healthy') : red('issues found')
  out(`aisy doctor — ${headline}  (${r.checks.length} checks · harness ${r.harnessVersion})`)

  let passed = 0
  let failed = 0
  let warned = 0

  for (const c of r.checks) {
    if (c.status === 'pass') {
      passed++
      out(dim(`  ✓ ${c.id}`))
    } else if (c.status === 'warn') {
      warned++
      out(`  ${yellow('⚠')} ${c.id} — ${c.detail}`)
    } else {
      failed++
      out(`  ${red('✗')} ${c.id} — ${c.detail}`)
    }
  }

  const parts: string[] = []
  if (passed > 0) parts.push(green(`${passed} passed`))
  if (failed > 0) parts.push(red(`${failed} failed`))
  if (warned > 0) parts.push(yellow(`${warned} warnings`))
  out('')
  out(parts.join(', '))

  if (failed > 0) {
    out('Run `aisy init` to configure, then `aisy doctor` again.')
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { command, flags, positional } = parseArgs(argv)
  const { ops, out, err } = deps
  const color = deps.color === true

  if (command === '' || command === 'help' || flags['help'] === true) {
    out(USAGE)
    return 0
  }

  switch (command) {
    case 'init': {
      const res = await ops.init({
        yes: flags['yes'] === true,
        force: flags['force'] === true,
        nonInteractive: flags['non-interactive'] === true,
      })
      out(res.completed ? `init: complete — scaffolded ${res.scaffolded.join(', ')}` : 'init: incomplete')
      for (const o of res.outcomes) if (o.result === 'failed') err(`  ${o.step}: ${o.detail}`)
      return res.completed ? 0 : 1
    }
    case 'setup': {
      const element = positional[0]
      if (element !== undefined) {
        if (!(SETUP_ELEMENTS as readonly string[]).includes(element)) {
          err(`setup: unknown element "${element}". Valid elements: ${SETUP_ELEMENTS.join(', ')}`)
          return 2
        }
      }
      // Route to init; element (if any) is passed through as a positional hint.
      // Per-element re-config flow is a documented follow-up — init currently ignores it.
      const res = await ops.init({
        yes: flags['yes'] === true,
        force: flags['force'] === true,
        nonInteractive: flags['non-interactive'] === true,
      })
      out(res.completed ? `init: complete — scaffolded ${res.scaffolded.join(', ')}` : 'init: incomplete')
      for (const o of res.outcomes) if (o.result === 'failed') err(`  ${o.step}: ${o.detail}`)
      return res.completed ? 0 : 1
    }
    case 'doctor': {
      // Build conditionally — exactOptionalPropertyTypes forbids passing `undefined`.
      const dopts: { fix?: boolean; postUpgrade?: boolean; only?: DoctorDomain[]; skip?: DoctorDomain[] } = {
        fix: flags['fix'] === true,
        postUpgrade: flags['post-upgrade'] === true,
      }
      const only = list(flags['only'])
      if (only) dopts.only = only
      const skip = list(flags['skip'])
      if (skip) dopts.skip = skip
      const report = await ops.doctor(dopts)
      if (flags['json'] === true) out(ops.toJson(report))
      else printReport(report, out, color)
      return report.ok ? 0 : 1
    }
    case 'diagnostics': {
      const out0 = typeof flags['out'] === 'string' ? (flags['out'] as string) : undefined
      const res = await ops.diagnostics(out0 !== undefined ? { out: out0 } : {})
      out(`diagnostics: wrote ${res.bundlePath} (redacted: ${res.redactedFields.join(', ') || 'none'})`)
      return 0
    }
    case 'update': {
      if (ops.update === undefined) {
        err('update: not supported')
        return 2
      }
      const r = await ops.update()
      out(r.message)
      return r.updated ? 0 : 1
    }
    default:
      err(`unknown command: ${command}`)
      err(USAGE)
      return 2
  }
}
