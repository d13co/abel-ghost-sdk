import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelReaderSDK, AssetTinyLabels as AssetTinyLabelsInternal } from "./generated/AbelReaderSDK.js"
import { chunked } from "./utils/chunked.js"
import { decodeUint64 } from "algosdk"
import { BoxName } from "@algorandfoundation/algokit-utils/types/app.js"

export interface AssetTinyLabels extends AssetTinyLabelsInternal {
  id: bigint
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
  }: {
    algorand: AlgorandClient
    concurrency?: number
    registryAppId?: number | bigint
    ghostAppId?: bigint
  }) {
    this.algorand = algorand
    this.registryAppId = registryAppId !== undefined ? BigInt(registryAppId) : undefined
    this.concurrency = concurrency
    this.baseSDK = new AbelReaderSDK({
      algorand: this.algorand,
      readerAccount: "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA",
      ghostAppId,
    })
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
}
