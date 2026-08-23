import { describe, expect, it, vi } from 'vitest'
import {
  RESTRICTED_CLONE_MIN_DOCKER_VERSION,
  isRestrictedCloneDockerVersionCompatible,
  isRestrictedCloneImageDigest,
  resolveRestrictedCloneTarget,
  type RestrictedCloneDnsAnswer,
  type RestrictedCloneDnsPort,
} from './restricted-public-clone.js'

function dns(answers: readonly RestrictedCloneDnsAnswer[]): RestrictedCloneDnsPort {
  return { resolve: vi.fn(async () => answers) }
}

describe('restricted public clone target', () => {
  it('shares the exact image and minimum Docker compatibility contract', () => {
    expect(RESTRICTED_CLONE_MIN_DOCKER_VERSION).toBe('29.5.2')
    expect(isRestrictedCloneDockerVersionCompatible('29.5.2')).toBe(true)
    expect(isRestrictedCloneDockerVersionCompatible('29.6.0-desktop.1')).toBe(true)
    expect(isRestrictedCloneDockerVersionCompatible('30.0.0')).toBe(true)
    expect(isRestrictedCloneDockerVersionCompatible('29.5.1')).toBe(false)
    expect(isRestrictedCloneDockerVersionCompatible('27.4.0')).toBe(false)
    expect(isRestrictedCloneDockerVersionCompatible('unknown')).toBe(false)
    expect(isRestrictedCloneImageDigest(`registry.example/aisy/clone@sha256:${'a'.repeat(64)}`)).toBe(true)
    expect(isRestrictedCloneImageDigest('registry.example/aisy/clone:latest')).toBe(false)
    expect(isRestrictedCloneImageDigest(`--help@sha256:${'a'.repeat(64)}`)).toBe(false)
    expect(isRestrictedCloneImageDigest(`Registry.example/aisy/clone@sha256:${'a'.repeat(64)}`)).toBe(false)
  })

  it('returns a frozen canonical target and exact reviewed address set', async () => {
    const resolver = dns([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])

    const target = await resolveRestrictedCloneTarget({
      url: 'https://EXAMPLE.org:443/team/repo.git',
      dns: resolver,
    })

    expect(target).toEqual({
      url: 'https://example.org/team/repo.git',
      hostname: 'example.org',
      port: 443,
      addresses: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
      transportPolicy: {
        connectOnlyToReviewedAddresses: true,
        preserveTlsServerName: true,
        followRedirects: false,
      },
    })
    expect(resolver.resolve).toHaveBeenCalledWith('example.org', undefined)
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target.addresses)).toBe(true)
    expect(Object.isFrozen(target.addresses[0])).toBe(true)
  })

  it.each([
    ['not a URL', 'CLONE_URL_INVALID'],
    [' https://github.com/org/repo.git', 'CLONE_URL_INVALID'],
    ['https://github.com/org\\repo.git', 'CLONE_URL_INVALID'],
    ['http://github.com/org/repo.git', 'CLONE_URL_HTTPS_REQUIRED'],
    ['file:///tmp/repo', 'CLONE_URL_HTTPS_REQUIRED'],
    ['ssh://git@github.com/org/repo.git', 'CLONE_URL_HTTPS_REQUIRED'],
    ['https://user@github.com/org/repo.git', 'CLONE_URL_CREDENTIALS_DENIED'],
    ['https://github.com:8443/org/repo.git', 'CLONE_URL_PORT_DENIED'],
    ['https://github.com/org/repo.git?ref=main', 'CLONE_URL_QUERY_DENIED'],
    ['https://github.com/org/repo.git#main', 'CLONE_URL_FRAGMENT_DENIED'],
    ['https://github.com/', 'CLONE_URL_PATH_DENIED'],
    ['https://github.com/-upload-pack/repo.git', 'CLONE_URL_PATH_DENIED'],
    ['https://github.com/%2Dupload-pack/repo.git', 'CLONE_URL_PATH_DENIED'],
    ['https://github.com/org%2Frepo.git', 'CLONE_URL_PATH_DENIED'],
    ['https://github.com/%zz/repo.git', 'CLONE_URL_PATH_DENIED'],
    ['https://localhost/org/repo.git', 'CLONE_URL_HOST_DENIED'],
    ['https://repo.internal/org/repo.git', 'CLONE_URL_HOST_DENIED'],
    ['https://example.com./org/repo.git', 'CLONE_URL_HOST_DENIED'],
  ])('rejects unsafe URL %s before DNS', async (url, code) => {
    const resolver = dns([{ address: '93.184.216.34', family: 4 }])

    await expect(resolveRestrictedCloneTarget({ url, dns: resolver })).rejects.toMatchObject({ code })
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['0.0.0.1', 4],
    ['10.1.2.3', 4],
    ['100.64.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.169.254', 4],
    ['172.16.0.1', 4],
    ['192.168.1.1', 4],
    ['192.0.2.1', 4],
    ['198.18.0.1', 4],
    ['198.51.100.1', 4],
    ['203.0.113.1', 4],
    ['224.0.0.1', 4],
    ['240.0.0.1', 4],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['64:ff9b::7f00:1', 6],
    ['100::1', 6],
    ['2001:db8::1', 6],
    ['2002::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['fec0::1', 6],
    ['ff02::1', 6],
    ['6000::1', 6],
  ] satisfies Array<[string, 4 | 6]>)('rejects non-public address %s', async (address, family) => {
    await expect(resolveRestrictedCloneTarget({
      url: 'https://git.example.net/team/repo.git',
      dns: dns([{ address, family }]),
    })).rejects.toMatchObject({ code: 'CLONE_TARGET_NOT_PUBLIC' })
  })

  it('rejects the whole DNS response when one answer becomes private', async () => {
    await expect(resolveRestrictedCloneTarget({
      url: 'https://git.example.net/team/repo.git',
      dns: dns([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    })).rejects.toMatchObject({ code: 'CLONE_TARGET_NOT_PUBLIC' })
  })

  it.each(([
    [] as RestrictedCloneDnsAnswer[],
    Array.from({ length: 17 }, (_, index) => ({ address: `8.8.8.${index + 1}`, family: 4 as const })),
    [{ address: '8.8.8.8', family: 6 as const }],
    [{ address: '8.8.8.8', family: 4 as const }, { address: '8.8.8.8', family: 4 as const }],
    [{ address: '2001:4860:4860::8888', family: 6 as const }, { address: '2001:4860:4860:0:0:0:0:8888', family: 6 as const }],
  ] as RestrictedCloneDnsAnswer[][]).map((answers) => [answers]))(
    'rejects malformed, excessive or duplicate DNS answers',
    async (answers) => {
      await expect(resolveRestrictedCloneTarget({
        url: 'https://git.example.net/team/repo.git',
        dns: dns(answers),
      })).rejects.toMatchObject({ code: 'CLONE_DNS_RESPONSE_DENIED' })
    },
  )

  it('accepts a public IP literal without consulting DNS', async () => {
    const resolver = dns([{ address: '127.0.0.1', family: 4 }])

    const target = await resolveRestrictedCloneTarget({
      url: 'https://1.1.1.1/team/repo.git',
      dns: resolver,
    })

    expect(target.addresses).toEqual([{ address: '1.1.1.1', family: 4 }])
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it('fails closed when a resolver violates the response contract', async () => {
    const invalidDns = {
      resolve: async () => undefined,
    } as unknown as RestrictedCloneDnsPort

    await expect(resolveRestrictedCloneTarget({
      url: 'https://git.example.net/team/repo.git',
      dns: invalidDns,
    })).rejects.toMatchObject({ code: 'CLONE_DNS_RESPONSE_DENIED' })
  })

  it('redacts resolver failures and maps abort to a stable cancellation', async () => {
    const controller = new AbortController()
    const failingDns: RestrictedCloneDnsPort = {
      resolve: async () => { throw new Error('resolver secret detail') },
    }
    await expect(resolveRestrictedCloneTarget({
      url: 'https://git.example.net/team/repo.git',
      dns: failingDns,
    })).rejects.toMatchObject({
      code: 'CLONE_DNS_LOOKUP_FAILED',
      message: 'CLONE_DNS_LOOKUP_FAILED',
    })

    controller.abort()
    await expect(resolveRestrictedCloneTarget({
      url: 'https://git.example.net/team/repo.git',
      dns: failingDns,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CLONE_TARGET_RESOLUTION_CANCELLED' })
  })
})
