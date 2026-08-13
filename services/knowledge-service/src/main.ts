import { EmbeddingClient } from './embedding-client.js'
import { loadConfig } from './config.js'
import { KnowledgeService } from './knowledge-service.js'
import { ZeroClient } from './zero-client.js'
import { createKnowledgeHttpServer } from './http.js'
import { ZokerbaseClient } from './zokerbase-client.js'
import { ZeroSshDeployer } from './zero-ssh-deployer.js'

const config = loadConfig()
const zokerbase = new ZokerbaseClient({ url: config.zokerbaseUrl, serviceKey: config.zokerbaseServiceKey, timeoutMs: config.requestTimeoutMs })
const zero = new ZeroClient({ url: config.zeroUrl, healthUrl: config.zeroHealthUrl, token: config.zeroToken, collection: config.zeroCollection, dimension: config.dimension, timeoutMs: config.requestTimeoutMs })
const embeddings = new EmbeddingClient({ baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey, model: config.embeddingModel, dimension: config.dimension, provider: config.embeddingProvider, protocol: config.embeddingProtocol, timeoutMs: config.requestTimeoutMs, allowDeterministic: config.allowDeterministicEmbeddings })
const service = new KnowledgeService({
  zokerbase,
  zero,
  embeddings,
  zeroCollection: config.zeroCollection,
  zeroDimension: config.dimension,
  chunkSize: config.chunkSize,
  chunkOverlap: config.chunkOverlap,
  defaultZeroEndpoint: config.zeroUrl,
  defaultZeroHealthEndpoint: config.zeroHealthUrl,
  defaultZeroToken: config.zeroToken,
  providerSecretKey: config.providerSecretKey,
  distributedDeployer: new ZeroSshDeployer(),
  createZeroClient: ({ endpoint, healthEndpoint, token, collection, dimension }) => new ZeroClient({ url: endpoint, healthUrl: healthEndpoint, token: token || config.zeroToken, collection, dimension, timeoutMs: config.requestTimeoutMs }),
})
const server = createKnowledgeHttpServer({ service, host: config.host, port: config.port, internalToken: config.internalToken })

await service.health()
server.listen(config.port, config.host, () => {
  process.stdout.write(`Knowledge Service listening on http://${config.host}:${config.port}\n`)
})

async function shutdown() {
  server.close(() => process.exit(0))
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
