export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SandboxStub {
  run(cmd: string, args: ReadonlyArray<string>): Promise<SandboxResult>
  enqueue(result: SandboxResult): void
  readonly calls: ReadonlyArray<{ cmd: string; args: ReadonlyArray<string> }>
}

export function makeSandboxStub(): SandboxStub {
  const queue: SandboxResult[] = []
  const calls: Array<{ cmd: string; args: ReadonlyArray<string> }> = []
  return {
    get calls() { return calls as ReadonlyArray<typeof calls[0]> },
    enqueue(r: SandboxResult): void {
      queue.push(r)
    },
    async run(cmd: string, args: readonly string[]): Promise<SandboxResult> {
      calls.push({ cmd, args })
      return queue.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
    },
  }
}
