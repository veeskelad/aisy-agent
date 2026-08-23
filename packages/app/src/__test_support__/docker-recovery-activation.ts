import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeDockerEngineUnixSocketBindingHash,
  makeNodeOwnedDockerEngineRecoveryBroker,
  PINNED_DOCKER_ENGINE_API_IDENTITY,
  type DockerEnginePinnedEndpointIdentityV1,
} from '../docker-engine-pinned-session.js'
import type {
  OwnedDockerAttestedCommandPort,
  OwnedDockerRecoveryLedger,
  OwnedDockerRecoveryResult,
} from '../execution-owned-docker-resources.js'

const SERVER_ID = 'aisy-test-recovery-engine'
const SERVER_VERSION = '29.5.2'

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

export interface DockerRecoveryActivationTestFixture {
  readonly socketPath: string
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  activate(
    ledger: OwnedDockerRecoveryLedger,
    docker: OwnedDockerAttestedCommandPort,
  ): Promise<OwnedDockerRecoveryResult>
  close(): Promise<void>
}

/** Test-only genuine pinned activation endpoint; never imported by production. */
export async function makeDockerRecoveryActivationTestFixture(): Promise<
  DockerRecoveryActivationTestFixture
> {
  // Keep the Unix socket below macOS' short sun_path limit.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ar-')))
  const socketPath = join(root, 'engine.sock')
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1.54/version') {
      response.end(JSON.stringify({
        Version: SERVER_VERSION,
        ApiVersion: '1.55',
        MinAPIVersion: '1.40',
      }))
      return
    }
    if (request.url === '/v1.54/info') {
      response.end(JSON.stringify({ ID: SERVER_ID, ServerVersion: SERVER_VERSION }))
      return
    }
    if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
      response.end('[]')
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await listen(server, socketPath)
  const endpointIdentity: DockerEnginePinnedEndpointIdentityV1 = Object.freeze({
    version: 1,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(socketPath),
    serverId: SERVER_ID,
    serverVersion: SERVER_VERSION,
    apiVersion: PINNED_DOCKER_ENGINE_API_IDENTITY,
  })
  let closed = false
  return Object.freeze({
    socketPath,
    endpointIdentity,
    activate(ledger: OwnedDockerRecoveryLedger, docker: OwnedDockerAttestedCommandPort) {
      const broker = makeNodeOwnedDockerEngineRecoveryBroker({
        socketPath,
        endpointIdentity,
        authority: ledger,
        timeoutMs: 1_000,
      })
      return ledger.activateAfterInstallationZero(docker, broker)
    },
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    },
  })
}
