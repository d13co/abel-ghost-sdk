import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import {
  AbelReaderSDK,
  AssetTinyLabels as AssetTinyLabelsInternal,
  BalanceInfo,
  BlockTimeAndTc,
} from "./generated/AbelReaderSDK.js"
import { chunked } from "./utils/chunked.js"
import { decodeUint64, ALGORAND_ZERO_ADDRESS_STRING } from "algosdk"
import { BoxName } from "@algorandfoundation/algokit-utils/types/app.js"

export interface AssetTinyLabels extends AssetTinyLabelsInternal {
  id: bigint
}

export interface BlockRoundTimeAndTc extends BlockTimeAndTc {
  rnd: bigint
}

export class AbelGhostSDK {
  static baseSDK = AbelReaderSDK

  public algorand: AlgorandClient
  public registryAppId?: bigint
  public baseSDK: AbelReaderSDK
  public concurrency: number

  constructor({
    algorand,
    registryAppId,
    concurrency = 4,
    ghostAppId,
    readerAccount,
  }: {
    algorand: AlgorandClient
    concurrency?: number
    registryAppId?: number | bigint
    ghostAppId?: bigint
    readerAccount?: string
  }) {
    this.algorand = algorand
    this.registryAppId = registryAppId !== undefined ? BigInt(registryAppId) : undefined
    this.concurrency = concurrency
    this.baseSDK = new AbelReaderSDK({
      algorand: this.algorand,
      readerAccount: readerAccount ?? "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE",
      ghostAppId,
    })
  }

  async getBalanceInfo(accounts: string[]): Promise<Map<string, BalanceInfo>> {
    const data = await this.getBalanceInfoInternal(accounts)
    return new Map(data.map((balance, i) => [accounts[i], balance]))
  }

  // chunk 63 is because we sim a single app call, max arg length issue (2KB, 63 * 32 bytes for addresses = 2016 bytes, leaving some buffer for other args and encoding overhead)
  // TODO optimize to 128 chunk and do 3 app calls in simulate
  @chunked(63)
  private async getBalanceInfoInternal(accounts: string[]): Promise<BalanceInfo[]> {
    return this.baseSDK.getBalanceInfo({ methodArgsOrArgsArray: { accounts } })
  }

  async getAuthAddrs(accounts: string[]): Promise<Map<string, string | undefined>> {
    const data = await this.getAuthAddrsInternal(accounts)
    // contract returns the zero address for accounts that are not rekeyed; surface those as undefined
    return new Map(data.map((authAddr, i) => [accounts[i], authAddr === ALGORAND_ZERO_ADDRESS_STRING ? undefined : authAddr]))
  }

  // TODO optimize to 128 chunk and do 3 app calls in simulate
  @chunked(63)
  private async getAuthAddrsInternal(accounts: string[]): Promise<string[]> {
    return this.baseSDK.getAuthAddrs({ methodArgsOrArgsArray: { accounts } })
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
