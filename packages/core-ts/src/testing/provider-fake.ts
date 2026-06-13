export interface ProviderResponse {
  content: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface ProviderFake {
  enqueue(response: ProviderResponse): void
  call(prompt: string): Promise<ProviderResponse>
  readonly calls: readonly string[]
}

export function makeProviderFake(): ProviderFake {
  const queue: ProviderResponse[] = []
  const calls: string[] = []
  return {
    get calls() { return calls as readonly string[] },
    enqueue(r: ProviderResponse): void {
      queue.push(r)
    },
    async call(prompt: string): Promise<ProviderResponse> {
      calls.push(prompt)
      const next = queue.shift()
      if (next === undefined) throw new Error('ProviderFake: no response queued')
      return next
    },
  }
}
