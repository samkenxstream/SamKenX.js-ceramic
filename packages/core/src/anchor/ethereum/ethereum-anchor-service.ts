import { CID } from 'multiformats/cid'
import * as providers from '@ethersproject/providers'
import lru from 'lru_map'
import {
  CeramicApi,
  AnchorServiceResponse,
  AnchorService,
  AnchorServiceAuth,
  AnchorStatus,
  AuthenticatedAnchorService,
  DiagnosticsLogger,
  FetchRequest,
  RequestAnchorParams,
  fetchJson,
  UnreachableCaseError,
} from '@ceramicnetwork/common'
import { StreamID } from '@ceramicnetwork/streamid'
import { Observable, interval, from, concat, of, defer } from 'rxjs'
import { concatMap, catchError, map, retry } from 'rxjs/operators'
import { RequestStatusName } from '@ceramicnetwork/anchor-utils'

/**
 * CID-streamId pair
 */
interface CidAndStream {
  readonly cid: CID
  readonly streamId: StreamID
}

const DEFAULT_POLL_INTERVAL = 60_000 // 60 seconds
const MAX_POLL_TIME = 86_400_000 // 24 hours

/**
 * Ethereum anchor service that stores root CIDs on Ethereum blockchain
 */
export class EthereumAnchorService implements AnchorService {
  private readonly requestsApiEndpoint: string
  private readonly chainIdApiEndpoint: string
  private _chainId: string
  private readonly providersCache: lru.LRUMap<string, providers.BaseProvider>
  private readonly _logger: DiagnosticsLogger
  /**
   * Retry a request to CAS every +pollInterval+ milliseconds.
   */
  private readonly pollInterval: number
  private readonly sendRequest: FetchRequest

  constructor(
    readonly anchorServiceUrl: string,
    logger: DiagnosticsLogger,
    pollInterval: number = DEFAULT_POLL_INTERVAL,
    sendRequest: FetchRequest = fetchJson
  ) {
    this.requestsApiEndpoint = this.anchorServiceUrl + '/api/v0/requests'
    this.chainIdApiEndpoint = this.anchorServiceUrl + '/api/v0/service-info/supported_chains'
    this._logger = logger
    this.pollInterval = pollInterval
    this.sendRequest = sendRequest
  }

  /**
   * Set Ceramic API instance
   *
   * @param ceramic - Ceramic API used for various purposes
   */
  set ceramic(ceramic: CeramicApi) {
    // Do Nothing
  }

  get url() {
    return this.anchorServiceUrl
  }

  async init(): Promise<void> {
    // Get the chainIds supported by our anchor service
    const response = await this.sendRequest(this.chainIdApiEndpoint)
    if (response.supportedChains.length > 1) {
      throw new Error(
        "Anchor service returned multiple supported chains, which isn't supported by js-ceramic yet"
      )
    }
    this._chainId = response.supportedChains[0]
  }

  /**
   * Requests anchoring service for current tip of the stream
   * @param streamId - Stream ID
   * @param tip - Tip CID of the stream
   */
  requestAnchor(params: RequestAnchorParams): Observable<AnchorServiceResponse> {
    const cidStreamPair: CidAndStream = { cid: params.tip, streamId: params.streamID }
    return concat(
      this._announcePending(cidStreamPair),
      this._makeAnchorRequest(params),
      this.pollForAnchorResponse(params.streamID, params.tip)
    ).pipe(
      catchError((error) =>
        of<AnchorServiceResponse>({
          status: AnchorStatus.FAILED,
          streamId: params.streamID,
          cid: params.tip,
          message: error.message,
        })
      )
    )
  }

  /**
   * @returns An array of the CAIP-2 chain IDs of the blockchains that are supported by this
   * anchor service.
   */
  async getSupportedChains(): Promise<Array<string>> {
    return [this._chainId]
  }

  private _announcePending(cidStream: CidAndStream): Observable<AnchorServiceResponse> {
    return of({
      status: AnchorStatus.PENDING,
      streamId: cidStream.streamId,
      cid: cidStream.cid,
      message: 'Sending anchoring request',
    })
  }

  /**
   * Send requests to an external Ceramic Anchor Service
   * @param params - a RequestAnchorParams object
   * @private
   */
  private _makeAnchorRequest(params: RequestAnchorParams): Observable<AnchorServiceResponse> {
    return defer(() =>
      from(
        this.sendRequest(this.requestsApiEndpoint, {
          method: 'POST',
          body: {
            streamId: params.streamID.toString(),
            cid: params.tip.toString(),
            timestamp: params.timestampISO,
          },
        })
      )
    ).pipe(
      retry({
        delay: (error) => {
          this._logger.err(
            new Error(
              `Error connecting to CAS while attempting to anchor ${params.streamID.toString()} at commit ${params.tip.toString()}: ${
                error.message
              }`
            )
          )
          return interval(this.pollInterval)
        },
      }),
      map((response) => {
        return this.parseResponse({ streamId: params.streamID, cid: params.tip }, response)
      })
    )
  }

  /**
   * Start polling the anchor service to learn of the results of an existing anchor request for the
   * given tip for the given stream.
   * @param streamId - Stream ID
   * @param tip - Tip CID of the stream
   */
  pollForAnchorResponse(streamId: StreamID, tip: CID): Observable<AnchorServiceResponse> {
    const started = new Date().getTime()
    const maxTime = started + MAX_POLL_TIME
    const requestUrl = [this.requestsApiEndpoint, tip.toString()].join('/')
    const cidStream = { cid: tip, streamId }

    return interval(this.pollInterval).pipe(
      concatMap(async () => {
        const now = new Date().getTime()
        if (now > maxTime) {
          throw new Error('Exceeded max anchor polling time limit')
        } else {
          const response = await this.sendRequest(requestUrl)
          return this.parseResponse(cidStream, response)
        }
      })
    )
  }

  /**
   * Parse JSON that CAS returns.
   */
  private parseResponse(cidStream: CidAndStream, json: any): AnchorServiceResponse {
    if (json.error) {
      return {
        status: AnchorStatus.FAILED,
        streamId: cidStream.streamId,
        cid: cidStream.cid,
        message: json.error,
      }
    }

    const status = json.status as RequestStatusName

    switch (status) {
      case RequestStatusName.READY:
      case RequestStatusName.PENDING:
        return {
          status: AnchorStatus.PENDING,
          streamId: cidStream.streamId,
          cid: cidStream.cid,
          message: json.message,
        }
      case RequestStatusName.PROCESSING:
        return {
          status: AnchorStatus.PROCESSING,
          streamId: cidStream.streamId,
          cid: cidStream.cid,
          message: json.message,
        }
      case RequestStatusName.FAILED:
        return {
          status: AnchorStatus.FAILED,
          streamId: cidStream.streamId,
          cid: cidStream.cid,
          message: json.message,
        }
      case RequestStatusName.REPLACED:
        return {
          status: AnchorStatus.REPLACED,
          streamId: cidStream.streamId,
          cid: cidStream.cid,
          message: json.message,
        }
      case RequestStatusName.COMPLETED: {
        const { anchorCommit } = json
        const anchorCommitCid = CID.parse(anchorCommit.cid.toString())
        return {
          status: AnchorStatus.ANCHORED,
          streamId: cidStream.streamId,
          cid: cidStream.cid,
          message: json.message,
          anchorCommit: anchorCommitCid,
        }
      }
      default:
        throw new UnreachableCaseError(status, `Unexpected anchor request status`)
    }
  }
}

/**
 * Ethereum anchor service that authenticates requests
 */
export class AuthenticatedEthereumAnchorService
  extends EthereumAnchorService
  implements AuthenticatedAnchorService
{
  readonly auth: AnchorServiceAuth

  constructor(
    auth: AnchorServiceAuth,
    readonly anchorServiceUrl: string,
    logger: DiagnosticsLogger,
    pollInterval: number = DEFAULT_POLL_INTERVAL
  ) {
    super(anchorServiceUrl, logger, pollInterval, auth.sendAuthenticatedRequest.bind(auth))
    this.auth = auth
  }

  /**
   * Set Ceramic API instance
   *
   * @param ceramic - Ceramic API used for various purposes
   */
  set ceramic(ceramic: CeramicApi) {
    this.auth.ceramic = ceramic
  }

  async init(): Promise<void> {
    await this.auth.init()
    await super.init()
  }
}
