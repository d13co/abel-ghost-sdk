import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import {
  AbelReaderSDK,
  AssetTinyLabels as AssetTinyLabelsInternal,
  BalanceInfo,
  BlockTimeAndTc,
  TinymanInfo,
  PactInfo as PactInfoInternal,
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

/** PACT pool types, indexed by the numeric code the contract logs. `""` = not a PACT pool */
const PACT_POOL_TYPES = ["", "CONSTANT_PRODUCT", "STABLESWAP", "MANAGED_WEIGHTED"] as const

export type PactPoolType = (typeof PACT_POOL_TYPES)[number]

export interface PactInfo extends Omit<PactInfoInternal, "type"> {
  /** `""` when the app is not an authenticated PACT pool */
  type: PactPoolType
}

/**
 * The account PACT creates each kind of pool from — `getPactInfo`'s root of trust, since the
 * creator of an app is stamped by consensus and cannot be forged. One per pool type: membership
 * of the set is not enough, because the same deployer created both stableswap pools and the
 * constant product *factory*.
 */
export type PactPoolCreators = Record<Exclude<PactPoolType, "">, string>

/** PACT's pool creators on mainnet */
export const MAINNET_PACT_POOL_CREATORS: PactPoolCreators = {
  CONSTANT_PRODUCT: "E5QGPA7LWVAVUADJFSZ6TLKRT6LYINNNQGQFVCPNTBHJM7I2HRYGSJBEMM",
  STABLESWAP: "PACTFIIFTBWHD52WFMKTSCDZWFVWZK4ZDSWIZHMROZLYD5PZFA4TLCWP7I",
  MANAGED_WEIGHTED: "H2XDAFUDTEPTN24HNUAZI6RCKQ2KDIIO45U767FEHGSGSEGCWWOK4QEIXM",
}

export class AbelGhostSDK {
  static baseSDK = AbelReaderSDK

  public algorand: AlgorandClient
  public registryAppId?: bigint
  public baseSDK: AbelReaderSDK
  public concurrency: number
  public debug: boolean = false
  /** memoized `client.isMainNet()` — an algod client's genesis never changes, so ask it once */
  private isMainNetPromise?: Promise<boolean>

  constructor({
    algorand,
    registryAppId,
    concurrency = 4,
    ghostAppId,
    readerAccount,
    cacheParamsTimeout,
    debug
  }: {
    algorand: AlgorandClient
    concurrency?: number
    registryAppId?: number | bigint
    ghostAppId?: bigint
    readerAccount?: string
    /** ms to cache algod suggested params for across chunked calls. Defaults to 75; 0 disables caching. */
    cacheParamsTimeout?: number
    debug?: boolean
  }) {
    this.algorand = algorand
    this.registryAppId = registryAppId !== undefined ? BigInt(registryAppId) : undefined
    this.concurrency = concurrency
    this.baseSDK = new AbelReaderSDK({
      algorand: this.algorand,
      readerAccount: readerAccount ?? "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE",
      ghostAppId,
      cacheParamsTimeout,
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

  /**
   * Look up PACT pool info for a batch of pool app ids.
   *
   * Each app is authenticated from algod alone: its global state shape picks the pool type, and
   * that type's PACT creator — stamped by consensus at app creation, so unforgeable — has to match.
   * `type` is `""` for anything that fails, including app ids that do not exist, have been deleted,
   * are not pools (factories, vaults), or are lookalike pools from an untrusted creator.
   *
   * Note that `asset1Id === 0` is normal here: ALGO is PACT's *primary* asset, the opposite of
   * Tinyman. The "is this a pool" test is `type !== ""`.
   *
   * `creators` are the expected pool creators, one per type. It defaults to
   * {@link MAINNET_PACT_POOL_CREATORS} when the client is connected to mainnet, and throws
   * otherwise — there is no safe default for another network, and getting it wrong would either
   * refuse every pool or trust an arbitrary one. Pass the zero address for a type to disable it.
   */
  async getPactInfo(
    pactAppIds: (number | bigint)[],
    creators?: PactPoolCreators,
  ): Promise<Map<bigint, PactInfo>> {
    const data = await this.getPactInfoInternal(
      pactAppIds.map((appId) => BigInt(appId)),
      await this.resolvePactPoolCreators(creators),
    )
    return new Map(
      data.map((info, i) => [
        BigInt(pactAppIds[i]),
        { ...info, type: PACT_POOL_TYPES[info.type] ?? "" } satisfies PactInfo,
      ]),
    )
  }

  private isMainNet(): Promise<boolean> {
    // do not cache a failed lookup: a transient algod error would otherwise poison every later call
    this.isMainNetPromise ??= this.algorand.client.isMainNet().catch((error: unknown) => {
      this.isMainNetPromise = undefined
      throw error
    })
    return this.isMainNetPromise
  }

  private async resolvePactPoolCreators(creators?: PactPoolCreators): Promise<PactPoolCreators> {
    if (creators) return creators
    if (!(await this.isMainNet()))
      throw new Error(
        "getPactInfo only knows PACT's pool creators on mainnet; pass `creators` explicitly for this network",
      )
    return MAINNET_PACT_POOL_CREATORS
  }

  @chunked(42)
  private async getPactInfoInternal(
    pactAppIds: bigint[],
    creators: PactPoolCreators,
  ): Promise<PactInfoInternal[]> {
    // one app call: each pool costs up to 3 of the group's 128 resource refs (the app itself plus
    // its two assets) => 3 * 42 = 126. the creators are arc4 addresses, i.e. plain app arg bytes,
    // so they cost no references
    return this.baseSDK.getPactInfo({
      methodArgsOrArgsArray: {
        constantProductCreator: creators.CONSTANT_PRODUCT,
        stableswapCreator: creators.STABLESWAP,
        managedWeightedCreator: creators.MANAGED_WEIGHTED,
        pactAppIds,
      },
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
