import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import {
  AbelReaderSDK,
  AssetTinyLabels as AssetTinyLabelsInternal,
  BalanceInfo,
  BlockTimeAndTc,
  TinymanInfo,
} from "./generated/AbelReaderSDK.js"
import { chunked } from "./utils/chunked.js"
import { decodeUint64, ALGORAND_ZERO_ADDRESS_STRING } from "algosdk"
import { BoxName } from "@algorandfoundation/algokit-utils/types/app.js"
import { chunk } from "./utils/chunk.js"

export interface AssetTinyLabels extends AssetTinyLabelsInternal {
  id: bigint
}

export interface BlockRoundTimeAndTc extends BlockTimeAndTc {
  rnd: bigint
}

export type { TinymanInfo }

/** Tinyman v2 AMM app on mainnet */
export const MAINNET_TINYMAN_V2_APP_ID = 1002541853n

export class AbelGhostSDK {
  static baseSDK = AbelReaderSDK

  public algorand: AlgorandClient
  public registryAppId?: bigint
  public baseSDK: AbelReaderSDK
  public concurrency: number
  public debug: boolean = false

  constructor({
    algorand,
    registryAppId,
    concurrency = 4,
    ghostAppId,
    readerAccount,
    debug
  }: {
    algorand: AlgorandClient
    concurrency?: number
    registryAppId?: number | bigint
    ghostAppId?: bigint
    readerAccount?: string
    debug?: boolean
  }) {
    this.algorand = algorand
    this.registryAppId = registryAppId !== undefined ? BigInt(registryAppId) : undefined
    this.concurrency = concurrency
    this.baseSDK = new AbelReaderSDK({
      algorand: this.algorand,
      readerAccount: readerAccount ?? "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE",
      ghostAppId,
      debug,
    })
  }

  async getBalanceInfo(accounts: string[]): Promise<Map<string, BalanceInfo>> {
    const data = await this.getBalanceInfoInternal(accounts)
    return new Map(data.map((balance, i) => [accounts[i], balance]))
  }

  @chunked(126)
  private async getBalanceInfoInternal(accounts: string[]): Promise<BalanceInfo[]> {
    // optimize to 126 chunk and do 2 app calls in simulate. 128 actual max but not taking a 3rd app call overhead for just a +2
    const methodArgsOrArgsArray = chunk(accounts, 63).map(accounts => ({ accounts }))
    return this.baseSDK.getBalanceInfo({ methodArgsOrArgsArray })
  }

  async getAuthAddrs(accounts: string[]): Promise<Map<string, string | undefined>> {
    const data = await this.getAuthAddrsInternal(accounts)
    // contract returns the zero address for accounts that are not rekeyed; surface those as undefined
    return new Map(data.map((authAddr, i) => [accounts[i], authAddr === ALGORAND_ZERO_ADDRESS_STRING ? undefined : authAddr]))
  }

  @chunked(126)
  private async getAuthAddrsInternal(accounts: string[]): Promise<string[]> {
    // optimize to 126 chunk and do 2 app calls in simulate. 128 actual max but not taking a 3rd app call overhead for just a +2
    const methodArgsOrArgsArray = chunk(accounts, 63).map(accounts => ({ accounts }))
    return this.baseSDK.getAuthAddrs({ methodArgsOrArgsArray })
  }

  async getAssetsTinyLabels(assetIds: number[] | bigint[]): Promise<Map<bigint, AssetTinyLabels>> {
    const data = await this.getAssetsTinyLabelsInternal(assetIds)
    return new Map(data.map((asset, i) => [BigInt(assetIds[i]), { ...asset, id: BigInt(assetIds[i]) }]))
  }

  @chunked(63)
  private async getAssetsTinyLabelsInternal(assetIds: number[] | bigint[]): Promise<AssetTinyLabelsInternal[]> {
    return this.baseSDK.getAssetsTiny({
      methodArgsOrArgsArray: { assetIds, abelAppId: this.registryAppId ?? 0n },
      extraMethodCallArgs: { extraFee: (assetIds.length * 1000).microAlgo() },
    })
  }

  async getAssetLabels(assetId: number | bigint): Promise<string[]> {
    if (!this.registryAppId) return []
    const { return: ret } = await this.baseSDK.factory
      .getAppClientById({ appId: this.registryAppId })
      .send.getAssetLabels({ args: { assetId: BigInt(assetId) } })
    return ret ?? []
  }

  async getAllAssetIDs(): Promise<bigint[]> {
    if (!this.registryAppId) return []
    return (await this.getBoxesByLength(8)).map((boxName) => decodeUint64(boxName.nameRaw, "bigint"))
  }

  private async getBoxesByLength(length: number): Promise<BoxName[]> {
    if (!this.registryAppId) return []
    const boxNames = await this.algorand.app.getBoxNames(this.registryAppId)
    return boxNames.filter((boxName) => boxName.nameRaw.length === length)
  }

  /**
   * Look up Tinyman pool info for a batch of pool (LP) escrow accounts.
   *
   * For each escrow it returns whether the account is rekeyed to the Tinyman app account
   * (`validRekey`) plus the pool's two asset ids and unit names, read from the escrow's
   * local state on the Tinyman app.
   *
   * Accounts that are not Tinyman pool escrows come back as `{ validRekey: false, asset1Id: 0n, ... }`
   * — a genuine pool always has a non-zero `asset1Id`, since Tinyman orders pairs so ALGO
   * (asset id 0) is always asset 2.
   */
  async getTinymanInfo(
    lpEscrows: string[],
    tinymanAppId: number | bigint = MAINNET_TINYMAN_V2_APP_ID,
  ): Promise<Map<string, TinymanInfo>> {
    const data = await this.getTinymanInfoInternal(lpEscrows, BigInt(tinymanAppId))
    return new Map(data.map((info, i) => [lpEscrows[i], info]))
  }

  @chunked(42)
  private async getTinymanInfoInternal(lpEscrows: string[], tinymanAppId: bigint): Promise<TinymanInfo[]> {
    // one app call: each escrow costs up to 3 of the group's 128 resource refs (the account
    // plus its two assets), on top of the single ref for the Tinyman app itself => 1 + 3 * 42 = 127
    return this.baseSDK.getTinymanInfo({
      methodArgsOrArgsArray: { tinymanAppId, lpEscrows },
    })
  }

  async getBlockTimesAndTc(firstRound: number | bigint, lastRound: number | bigint): Promise<BlockRoundTimeAndTc[]> {
    const firstDataRound = BigInt(firstRound)
    const lastDataRound = BigInt(lastRound)
    const simRound = BigInt(lastRound)
    const firstValid = simRound  + BigInt(1) // simulating with first-valid after simulate round, this is actually valid
    const lastValid = simRound + BigInt(1)
    return (
      await this.baseSDK.getBlockTimesAndTc({
        methodArgsOrArgsArray: { firstRound: firstDataRound, lastRound: lastDataRound },
        extraMethodCallArgs: { firstValidRound: firstValid, lastValidRound: lastValid },
        extraSimulateArgs: { round: simRound },
      })
    ).map((data, i) => ({
      ...data,
      rnd: BigInt(firstDataRound) + BigInt(i),
    }))
  }
}
