// Sandbox bash adapter (runtime).
//
// Provides executeTool's `runBash` port by running each command in a locked-down
// throwaway container (ADR-0012 invariants: cap-drop ALL, no-new-privileges,
// default-deny network, read-only root with a writable workspace mount + tmpfs,
// pids cap, optional gVisor runtime). The docker invocation is injected so the
// argv construction and result mapping are unit-tested without a daemon.

import { execFile } from 'node:child_process'

export interface DockerResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface DockerBashDeps {
  /** Container image to run commands in. */
  image: string
  /** Host workspace mounted read-write at /work. */
  workspaceRoot: string
  /** Run `docker` with these args; injected for tests. Default: child_process. */
  runDocker?: (args: string[]) => Promise<DockerResult>
  /** Use the gVisor (runsc) runtime when available. */
  gvisor?: boolean
  /** Per-command wall-clock cap (seconds) enforced inside the container. */
  timeoutSec?: number
}

/** Build the hardened `docker run` argv for a single command. */
export function dockerRunArgs(deps: DockerBashDeps, cmd: string): string[] {
  const wrapped = deps.timeoutSec ? `timeout ${deps.timeoutSec}s sh -lc ${shellQuote(cmd)}` : `sh -lc ${shellQuote(cmd)}`
  return [
    'run',
    '--rm',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--network=none',
    '--read-only',
    '--tmpfs=/tmp',
    '--pids-limit=256',
    ...(deps.gvisor ? ['--runtime=runsc'] : []),
    '-v',
    `${deps.workspaceRoot}:/work`,
    '-w',
    '/work',
    deps.image,
    'sh',
    '-lc',
    wrapped,
  ]
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function defaultRunDocker(args: string[]): Promise<DockerResult> {
  return new Promise<DockerResult>((resolve) => {
    execFile('docker', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code })
    })
  })
}

export function makeDockerBash(deps: DockerBashDeps): (cmd: string) => Promise<DockerResult> {
  const runDocker = deps.runDocker ?? defaultRunDocker
  return (cmd: string): Promise<DockerResult> => runDocker(dockerRunArgs(deps, cmd))
}
