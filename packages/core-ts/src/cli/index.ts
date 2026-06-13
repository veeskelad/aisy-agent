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
}

const USAGE = `aisy — personal agent harness

Usage:
  aisy init [--yes] [--force] [--non-interactive]   Scaffold & validate a config (idempotent)
  aisy doctor [--fix] [--json] [--post-upgrade]     Full-stack health check (read-only by default)
              [--only=a,b] [--skip=a,b]
  aisy diagnostics [--out=path]                     Write a redacted support bundle
  aisy --help                                       Show this help`

const list = (v: string | boolean | undefined): DoctorDomain[] | undefined =>
  typeof v === 'string' && v.length > 0 ? (v.split(',') as DoctorDomain[]) : undefined

function printReport(r: DoctorReport, out: (s: string) => void): void {
  out(`doctor: ${r.ok ? 'OK' : 'FAIL'} (${r.checks.length} checks, harness ${r.harnessVersion})`)
  for (const c of r.checks) {
    if (c.status !== 'pass') out(`  [${c.status}/${c.severity}] ${c.id} — ${c.detail}`)
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { command, flags } = parseArgs(argv)
  const { ops, out, err } = deps

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
      else printReport(report, out)
      return report.ok ? 0 : 1
    }
    case 'diagnostics': {
      const out0 = typeof flags['out'] === 'string' ? (flags['out'] as string) : undefined
      const res = await ops.diagnostics(out0 !== undefined ? { out: out0 } : {})
      out(`diagnostics: wrote ${res.bundlePath} (redacted: ${res.redactedFields.join(', ') || 'none'})`)
      return 0
    }
    default:
      err(`unknown command: ${command}`)
      err(USAGE)
      return 2
  }
}
