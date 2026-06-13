export interface Clock {
  now(): string
}

export const realClock: Clock = {
  now: () => new Date().toISOString(),
}

export function fakeClock(initialMs = 0): Clock & { advance(ms: number): void } {
  let current = initialMs
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms
    },
  }
}
