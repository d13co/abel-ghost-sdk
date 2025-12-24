import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelReaderSDK } from "./generated/AbelReaderSDK.js"
import { chunked } from "./utils/chunked.js"

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

  @chunked(63)
  getAssetsTinyLabels(assetIds: number[] | bigint[]) {
    if (!this.registryAppId) throw new Error("Can not get labels without registry app id")
    return this.baseSDK.getAssetsTiny({
      methodArgsOrArgsArray: { assetIds, abelAppId: this.registryAppId },
      extraMethodCallArgs: { extraFee: (assetIds.length * 1000).microAlgo() },
    })
  }

  @chunked(128)
  getAssetsTiny(assetIds: number[] | bigint[]) {
    return this.baseSDK.getAssetsTiny({
      methodArgsOrArgsArray: { assetIds, abelAppId: 0n },
    })
  }
}
