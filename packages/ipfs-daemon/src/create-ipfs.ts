import { path } from 'go-ipfs'
import * as Ctl from 'ipfsd-ctl'
import * as ipfsClient from 'ipfs-http-client'
import getPort from 'get-port'
import mergeOpts from 'merge-options'
import type { IpfsApi } from '@ceramicnetwork/common'
import tmp from 'tmp-promise'

const mergeOptions = mergeOpts.bind({ ignoreUndefined: true })

const ipfsHttpModule = {
  create: (ipfsEndpoint: string) => {
    return ipfsClient.create({
      url: ipfsEndpoint,
    })
  },
}

const createFactory = () => {
  return Ctl.createFactory(
    {
      ipfsHttpModule,
      ipfsOptions: {
        repoAutoMigrate: true,
      },
    },
    {
      go: {
        ipfsBin: path(),
      },
    }
  )
}

export async function createController(
  ipfsOptions: Ctl.IPFSOptions,
  disposable = true
): Promise<Ctl.Controller> {
  const ipfsd = await createFactory().spawn({
    type: 'go',
    ipfsOptions,
    disposable,
  })
  if (disposable) {
    return ipfsd
  }

  return ipfsd.init()
}

/**
 * Create the default IPFS Options
 * @param override IFPS config for override
 * @param repoPath The file path at which to store the IPFS node’s data
 * @returns
 */

async function createIpfsOptions(
  override: Partial<Ctl.IPFSOptions> = {},
  repoPath?: string
): Promise<Ctl.IPFSOptions> {
  const swarmPort = await getPort()
  const apiPort = await getPort()
  const gatewayPort = await getPort()

  return mergeOptions(
    {
      start: true,
      config: {
        Addresses: {
          Swarm: [`/ip4/127.0.0.1/tcp/${swarmPort}`],
          Gateway: `/ip4/127.0.0.1/tcp/${gatewayPort}`,
          API: `/ip4/127.0.0.1/tcp/${apiPort}`,
        },
        Pubsub: {
          Enabled: true,
          SeenMessagesTTL: "10m"
        },
        Bootstrap: [],
        "Peering": {
          "Peers": [
            {
              "Addrs": [
                "/dns4/go-ipfs-ceramic-private-mainnet-external.3boxlabs.com/tcp/4011/ws/p2p/QmXALVsXZwPWTUbsT8G6VVzzgTJaAWRUD7FWL5f7d5ubAL"
              ],
              "ID": "QmXALVsXZwPWTUbsT8G6VVzzgTJaAWRUD7FWL5f7d5ubAL"
            },
            {
              "Addrs": [
                "/dns4/go-ipfs-ceramic-private-cas-mainnet-external.3boxlabs.com/tcp/4011/ws/p2p/QmUvEKXuorR7YksrVgA7yKGbfjWHuCRisw2cH9iqRVM9P8"
              ],
              "ID": "QmUvEKXuorR7YksrVgA7yKGbfjWHuCRisw2cH9iqRVM9P8"
            },
            {
              "Addrs": [
                "/dns4/go-ipfs-ceramic-elp-1-1-external.3boxlabs.com/tcp/4011/ws/p2p/QmUiF8Au7wjhAF9BYYMNQRW5KhY7o8fq4RUozzkWvHXQrZ"
              ],
              "ID": "QmUiF8Au7wjhAF9BYYMNQRW5KhY7o8fq4RUozzkWvHXQrZ"
            },
            {
              "Addrs": [
                "/dns4/go-ipfs-ceramic-elp-1-2-external.3boxlabs.com/tcp/4011/ws/p2p/QmRNw9ZimjSwujzS3euqSYxDW9EHDU5LB3NbLQ5vJ13hwJ"
              ],
              "ID": "QmRNw9ZimjSwujzS3euqSYxDW9EHDU5LB3NbLQ5vJ13hwJ"
            },
            {
              "Addrs": [
                "/dns4/go-ipfs-ceramic-private-cas-clay-external.3boxlabs.com/tcp/4011/ws/p2p/QmbeBTzSccH8xYottaYeyVX8QsKyox1ExfRx7T1iBqRyCd"
              ],
              "ID": "QmbeBTzSccH8xYottaYeyVX8QsKyox1ExfRx7T1iBqRyCd"
            }
          ]
        },
      },
    },
    repoPath ? { repo: `${repoPath}/ipfs${swarmPort}/` } : {},
    override
  )
}

const createInstanceByType = {
  go: async (ipfsOptions: Ctl.IPFSOptions, disposable = true): Promise<IpfsApi> => {
    if (!ipfsOptions.start) {
      throw Error('go IPFS instances must be started')
    }
    const ipfsd = await createController(ipfsOptions, disposable)
    // API is only set on started controllers
    const started = await ipfsd.start()
    return started.api
  },
}
/**
 * Create an IPFS instance
 * @param overrideConfig - IFPS config for override
 */
export async function createIPFS(
  overrideConfig: Partial<Ctl.IPFSOptions> = {},
  disposable = true
): Promise<IpfsApi> {
  const flavor = process.env.IPFS_FLAVOR || 'go'
  if (!(flavor in createInstanceByType)) throw new Error(`Unsupported IPFS flavor "${flavor}"`)

  if (!overrideConfig.repo) {
    const tmpFolder = await tmp.dir({ unsafeCleanup: true })

    const ipfsOptions = await createIpfsOptions(overrideConfig, tmpFolder.path)

    const instance = await createInstanceByType[flavor](ipfsOptions, disposable)

    // IPFS does not notify you when it stops.
    // Here we intercept a call to `ipfs.stop` to clean up IPFS repository folder.
    // Poor man's hook.
    return new Proxy(instance, {
      get(target: any, p: PropertyKey): any {
        if (p === 'stop') {
          return () => {
            const vanilla = target[p]
            return vanilla().finally(() => tmpFolder.cleanup())
          }
        }
        return target[p]
      },
    })
  }

  const ipfsOptions = await createIpfsOptions(overrideConfig)

  return createInstanceByType[flavor](ipfsOptions, disposable)
}

/**
 * Connect two IPFS instances via `swarm.connect`
 *
 * @param a - Initiates connection
 * @param b - Receives connection
 */
export async function swarmConnect(a: IpfsApi, b: IpfsApi) {
  const addressB = (await b.id()).addresses[0]
  const addressA = (await a.id()).addresses[0]
  await a.swarm.connect(addressB)
  await b.swarm.connect(addressA)
}

/**
 * Start `n` IPFS (go-ipfs or js-ipfs based on `process.env.IPFS_FLAVOR`) instances, and stop them after `task` is done.
 * @param n - Number of IPFS instances to create.
 * @param task - Function that uses the IPFS instances.
 */
export async function withFleet(
  n: number,
  task: (instances: IpfsApi[]) => Promise<void>
): Promise<void> {
  const flavor = process.env.IPFS_FLAVOR || 'go'

  if (flavor.toLowerCase() == 'js') {
    return withJsFleet(n, task)
  } else {
    return withGoFleet(n, task)
  }
}

/**
 * Start `n` go-ipfs instances, and stop them after `task` is done.
 * @param n - Number of go-ipfs instances to create.
 * @param task - Function that uses go-ipfs instances.
 */
async function withGoFleet(
  n: number,
  task: (instances: IpfsApi[]) => Promise<void>,
  overrideConfig: Record<string, unknown> = {}
): Promise<void> {
  const factory = createFactory()

  const controllers = await Promise.all(
    Array.from({ length: n }).map(async () => {
      const ipfsOptions = await createIpfsOptions(overrideConfig)
      return factory.spawn({
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore ipfsd-ctl uses own type, that is _very_ similar to Options from ipfs-core
        ipfsOptions,
      })
    })
  )
  const instances = controllers.map((c) => c.api)
  try {
    await task(instances)
  } finally {
    await factory.clean()
  }
}

/**
 * Start `n` js-ipfs instances, and stop them after `task` is done.
 * @param n - Number of js-ipfs instances to create.
 * @param task - Function that uses the IPFS instances.
 */
async function withJsFleet(
  n: number,
  task: (instances: IpfsApi[]) => Promise<void>,
  overrideConfig: Record<string, unknown> = {}
): Promise<void> {
  const instances = await Promise.all(
    Array.from({ length: n }).map(() => createIPFS(overrideConfig))
  )
  try {
    await task(instances)
  } finally {
    instances.map((instance) => instance.stop())
  }
}
