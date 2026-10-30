import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import type { AppState } from "@algorandfoundation/algokit-utils/types/app"
import { ALGORAND_ZERO_ADDRESS_STRING, ABIType, decodeUint64 } from "algosdk"
import {
  GHOST_META,
  AbelReaderSDK,
  AssetHolding,
  AssetTinyLabels as AssetTinyLabelsInternal,
  BalanceInfo,
  BlockTimeAndTc,
  GhostkitBackend,
  GhostkitChunkOptions,
  GhostkitFee,
  GhostkitNode,
  GhostkitRound,
  GhostkitRoundResult,
  GhostkitRoundsOptions,
  GhostkitSDKParams,
  GHOSTKIT_STOCK_LIMITS,
  PactInfo as PactInfoInternal,
  TinymanInfo,
  TinymanPoolState as TinymanPoolStateInternal,
} from "./generated/AbelReaderSDK.js"
import {
  bytesToBigInt,
  protocolFeeGrowth,
  priceInterval,
  volumeFromProtocolFees,
  type ProtocolFeeGrowth,
  type TinymanPoolState,
  type TinymanPriceInterval,
} from "./twap.js"

export {
  cumulativePricesAt,
  priceInterval,
  protocolFeeGrowth,
  roundRange,
  twap,
  volumeEstimate,
  volumeFromProtocolFees,
  vwap,
} from "./twap.js"
export type { ProtocolFeeGrowth, TinymanPoolState, TinymanPriceInterval } from "./twap.js"
export { GhostkitError, GHOST_META, GHOSTKIT_STOCK_LIMITS } from "./generated/AbelReaderSDK.js"
export type {
  AssetHolding,
  BalanceInfo,
  GhostkitBackend,
  GhostkitChunkOptions,
  GhostkitNode,
  GhostkitRoundResult,
  GhostkitRoundsOptions,
  TinymanInfo,
}

export interface AssetTinyLabels extends AssetTinyLabelsInternal {
  id: bigint
}

export interface BlockRoundTimeAndTc extends BlockTimeAndTc {
  rnd: bigint
}

/** Tinyman v2 AMM app on mainnet */
export const MAINNET_TINYMAN_V2_APP_ID = 1002541853n

/** The Abel asset label registry on mainnet */
export const MAINNET_ABEL_REGISTRY_APP_ID = 2914159523n

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

/** Options of a single read */
export interface ReadOptions {
  /** Read as of the end of this round; the latest round when unset. Any round since genesis on a dtalgorand node with time travel on */
  round?: GhostkitRound
  /** Overrides the method's default chunking, e.g. to tune packing; `false` sends everything in one app call */
  chunk?: GhostkitChunkOptions | false
  /** `getBalanceInfo` and `getAssetsTinyLabels` only: spread the items over the reader's four array arguments */
  packing?: ArgPacking
}

/**
 * How to spread a read's items over app calls by hand, with the reader's four array arguments. One app arg holds at
 * most 4,096 bytes (127 addresses or 511 asset ids), but an app call can carry several.
 */
export interface ArgPacking {
  /** items per array argument */
  perArg: number
  /** array arguments filled per app call, 1 to 4 */
  args: 1 | 2 | 3 | 4
  /** items per group, e.g. 256 for `getAssetsTinyLabels`, whose inner app calls a group caps at 256 */
  perGroup?: number
}

/** A read at several rounds: one result per round, in order, each `{ round, ok, value }` or `{ round, ok: false, error }` */
export type AtRounds<T> = GhostkitRoundResult<T>[]

/** Options of a read at several rounds */
export interface AtRoundsOptions extends GhostkitRoundsOptions {
  /** Overrides the method's default chunking */
  chunk?: GhostkitChunkOptions | false
  /** `getBalanceInfoAtRounds` and `getAssetsTinyLabelsAtRounds` only: see `ReadOptions.packing` */
  packing?: ArgPacking
}

/** An Abel label: its id (e.g. `pv`), name, URL and how many assets carry it */
export interface AbelLabel {
  id: string
  name: string
  url: string
  numAssets: bigint
  numOperators: bigint
}

/** A change to the labels of one asset in the Abel registry */
export interface AbelLabelChange {
  round: bigint
  timestamp: number
  assetId: bigint
  /** the asset's labels after the change; empty when its box was deleted */
  labels: string[]
  deleted: boolean
}

/** One version of a Tinyman pool, from its escrow's local state history */
export interface TinymanPoolVersion {
  round: bigint
  timestamp: number
  /** the escrow opted out (the pool was removed) in this round */
  deleted: boolean
  /** the pool state after this round, unless deleted */
  state?: TinymanPoolState
}

/** The dtalgorand fork's `GET /v2/applications/{id}/boxes`, with values */
interface BoxListing {
  include(what: "values"): BoxListing
  limit(n: number): BoxListing
  round(round: GhostkitRound): BoxListing
  next(token: string): BoxListing
  do(): Promise<{ boxes: { name: Uint8Array; value?: Uint8Array }[]; nextToken?: string }>
}

const STRING_ARRAY = ABIType.from("string[]")
/** The opcode budget each app call adds to its group's pool */
const APP_CALL_BUDGET = 700
/** The most transactions in a group */
const MAX_GROUP_SIZE = 16
const LABEL_DESCRIPTOR = ABIType.from("(string,string,uint64,uint64)")

type Ghost = AbelReaderSDK

export class AbelGhostSDK {
  static baseSDK = AbelReaderSDK

  public algorand: AlgorandClient
  public registryAppId?: bigint
  /** The ghostkit-generated SDK the reads run on */
  public baseSDK: AbelReaderSDK
  /** memoized `client.isMainNet()` — an algod client's genesis never changes, so ask it once */
  private isMainNetPromise?: Promise<boolean>
  private backendMode: GhostkitSDKParams["backend"]
  /** The most items one read sends in one request (see `sliced`); estimated from their bytes when unset */
  public maxItemsPerRequest?: number
  private backendPromise?: Promise<void>
  /** The extra opcode budget each group asks for: the node's most, since a full group of a batch reader needs it */
  private opcodeBudget = 170_000

  constructor({
    algorand,
    registryAppId,
    ghostAppId,
    readerAccount,
    cacheParamsTimeout,
    backend,
    ghostFee,
    debug,
    maxItemsPerRequest,
  }: {
    algorand: AlgorandClient
    /** The Abel registry app, for asset labels (see MAINNET_ABEL_REGISTRY_APP_ID) */
    registryAppId?: number | bigint
    /** Call this deployed reader app instead of creating the ghost in each simulate */
    ghostAppId?: bigint
    /** The account the reads are sent from; defaults to the network's fee sink */
    readerAccount?: string
    /** ms that reads at the latest round reuse suggested params for (default 3,000) */
    cacheParamsTimeout?: number
    /**
     * How reads are sent (see ghostkit): `auto` (default) uses read-only queries on a dtalgorand node with queries on,
     * else its extended simulate, else one simulate per group; `query` always queries and `dt` always uses the extended
     * simulate (both throw on stock algod, and `query` on a node with queries off); `stock` one simulate per group; or
     * your own ghostkit backend
     */
    backend?: GhostkitSDKParams["backend"]
    /** What each simulated group offers in fees (default 1 Algo; nothing is paid) */
    ghostFee?: GhostkitFee
    debug?: boolean
    /**
     * The most items (accounts, assets, pools) one read sends in one request; larger inputs are split and the parts
     * run concurrently. A dtalgorand node refuses request bodies over 1 MB, and each app call also carries the reader
     * program. Default 2,048, fewer if their bytes would come near 1 MB
     */
    maxItemsPerRequest?: number
  }) {
    this.maxItemsPerRequest = maxItemsPerRequest
    this.algorand = algorand
    this.registryAppId = registryAppId !== undefined ? BigInt(registryAppId) : undefined
    this.backendMode = backend ?? "auto"
    this.baseSDK = new AbelReaderSDK({ algorand, readerAccount, ghostAppId, cacheParamsTimeout, ghostFee, debug, backend: this.backendMode })
  }

  /**
   * Fetches what the first read waits for once (the node's capabilities, and suggested params unless reads are
   * queried), and sets the opcode budget each group asks for from the backend ghostkit picks.
   */
  private ready(): Promise<void> {
    // do not cache a failed lookup: a transient algod error would otherwise poison every later call
    this.backendPromise ??= Promise.all([this.getBackend(), this.baseSDK.prefetch()]).then(
      async ([{ name, limits }]) => {
        this.opcodeBudget = limits.maxExtraOpcodeBudget
        // ghostkit simulates a group whose extra budget and 700 per app call are over a query's per-call budget
        const node = name === "query" ? await this.getNode() : undefined
        if (node?.kind === "dt" && node.query) {
          this.opcodeBudget = Math.min(this.opcodeBudget, Math.max(0, node.query.maxCallBudget - APP_CALL_BUDGET * MAX_GROUP_SIZE))
        }
      },
      (error: unknown) => {
        this.backendPromise = undefined
        throw error
      },
    )
    return this.backendPromise
  }

  /** What ghostkit found about the node: `dt` with its simulate limits (and `query` with queries on), or `stock` and why */
  getNode(): Promise<GhostkitNode> {
    return this.baseSDK.getNode()
  }

  /**
   * The backend the reads use, `query`, `dt` or `stock` (or your own backend's name), and the node's simulate limits.
   * Throws like the reads would for a `dt` or `query` backend that the node or libraries can't run
   */
  async getBackend(): Promise<Pick<GhostkitBackend, "name" | "limits">> {
    const mode = this.backendMode ?? "auto"
    if (typeof mode === "object") return { name: mode.name, limits: mode.limits }
    if (mode === "stock") return { name: "stock", limits: GHOSTKIT_STOCK_LIMITS }
    const node = await this.getNode()
    if (node.kind !== "dt") {
      if (mode !== "auto") throw new Error(`abel-ghost-sdk: backend '${mode}' can't be used: ${node.reason}`)
      return { name: "stock", limits: node.limits }
    }
    if (mode === "query" && !node.query) throw new Error("abel-ghost-sdk: backend 'query' can't be used: the node has queries off")
    return { name: mode === "dt" || !node.query ? "dt" : "query", limits: node.limits }
  }

  private budget() {
    return { extraOpcodeBudget: this.opcodeBudget }
  }

  /** The reader SDK at `round`, or at the latest round */
  private async at(round?: GhostkitRound): Promise<Ghost> {
    await this.ready()
    return round === undefined ? this.baseSDK : this.baseSDK.atRound(round)
  }

  /** Runs `call` at each round in as few requests as the node allows, and decodes each round's value */
  /**
   * Runs `call` over `items`, in slices of at most `maxItemsPerRequest`, concurrently. ghostkit packs a call's groups
   * into as few requests as the node's limits allow, but a dtalgorand node also refuses request bodies over 1 MB,
   * which it doesn't report: a slice keeps each request under it
   */
  private async sliced<I, R>(items: I[], call: (slice: I[]) => Promise<R[]>, perRequest = this.perRequest(32, 127)): Promise<R[]> {
    if (items.length <= perRequest) return call(items)
    const slices = Array.from({ length: Math.ceil(items.length / perRequest) }, (_, i) => items.slice(i * perRequest, (i + 1) * perRequest))
    return (await Promise.all(slices.map(call))).flat()
  }

  /**
   * Items per request: `maxItemsPerRequest`, else 2,048, or fewer if that many would take a request near the node's
   * 1 MB limit (estimated at 800 KB: each item takes `itemBytes` of app args, and every `itemsPerTxn` items share an
   * app call, which carries the reader program and a few hundred bytes of transaction). On the d13 dtalgorand node,
   * several requests of about one full group ran faster than fewer, larger ones
   */
  private perRequest(itemBytes: number, itemsPerTxn: number): number {
    if (this.maxItemsPerRequest) return this.maxItemsPerRequest
    return Math.min(2048, Math.floor(800_000 / (itemBytes + (GHOST_META.approvalBytes + 400) / itemsPerTxn)))
  }

  /** Items per request for a read packed with `packing`, or chunked by ghostkit with `chunk` (4 KB per app call by default) */
  private perRequestFor(itemBytes: number, { chunk, packing }: { chunk?: GhostkitChunkOptions | false; packing?: ArgPacking }): number {
    if (packing) return this.perRequest(itemBytes, packing.perArg * packing.args)
    const argBytes = Math.min((chunk && chunk.maxArgBytes) || 4096, 4096)
    const perTxn = Math.min(Math.floor((argBytes - 16) / itemBytes), (chunk && chunk.maxPerTxn) || Infinity)
    return this.perRequest(itemBytes, perTxn)
  }

  /**
   * Runs `call` over `items` at each round, in as few requests as the node allows (and slices, see `sliced`), and
   * decodes each round's results, in item order
   */
  private async atRoundsDecoded<I, R, T>(
    rounds: GhostkitRound[],
    items: I[],
    call: (ghost: Ghost, slice: I[]) => Promise<R[]> | Promise<R[]>[],
    decode: (raw: R[]) => T,
    { chunk: _chunk, packing: _packing, ...options }: AtRoundsOptions = {},
    perRequest?: number,
  ): Promise<AtRounds<T>> {
    await this.ready()
    const withBudget = { extraOpcodeBudget: this.opcodeBudget, ...options }
    // each slice's calls run at every round; a call returns its items' results, and several calls theirs in order
    const slices = await this.sliced(
      items,
      async (slice) => [
        await this.baseSDK.atRounds(
          rounds,
          (ghost) => {
            const calls = call(ghost, slice)
            return Array.isArray(calls) ? calls : [calls]
          },
          withBudget,
        ),
      ],
      perRequest,
    )
    return slices[0].map((first, r) => {
      const failed = slices.find((slice) => !slice[r].ok)?.[r]
      if (failed && !failed.ok) return failed
      const raw = slices.flatMap((slice) => (slice[r] as { value: R[][] }).value.flat())
      return { ...first, ok: true as const, value: decode(raw) }
    })
  }

  /** Runs `call` once per group of `packGroups(items, packing)`, all in one `batch`, and joins the results in order */
  private async packedBatch<I, R>(ghost: Ghost, items: I[], packing: ArgPacking, call: (ghost: Ghost, txns: I[][][]) => Promise<R[]>): Promise<R[]> {
    const groups = packGroups(items, packing)
    const results = await ghost.batch((s) => groups.map((txns) => call(s, txns)), { extraOpcodeBudget: this.opcodeBudget })
    return (results as R[][]).flat()
  }

  // ---- balances

  async getBalanceInfo(accounts: string[], { round, chunk, packing }: ReadOptions = {}): Promise<Map<string, BalanceInfo>> {
    const ghost = await this.at(round)
    const raw = await this.sliced(
      accounts,
      (slice) =>
        packing
          ? this.packedBatch(ghost, slice, packing, (s, txns) => s.getBalanceInfo({ methodArgsOrArgsArray: txns.map(balanceArgs), chunk: false }))
          : ghost.getBalanceInfo({ methodArgsOrArgsArray: { ...balanceArgs([slice]) }, chunk, extraSimulateArgs: this.budget() }),
      this.perRequestFor(32, { chunk, packing }),
    )
    return zipMap(accounts, raw)
  }

  /** Balances of `accounts` at each of `rounds`, any distance apart */
  async getBalanceInfoAtRounds(
    accounts: string[],
    rounds: GhostkitRound[],
    options: AtRoundsOptions = {},
  ): Promise<AtRounds<Map<string, BalanceInfo>>> {
    return this.atRoundsDecoded(
      rounds,
      accounts,
      (ghost, slice) =>
        options.packing
          ? packGroups(slice, options.packing).map((txns) => ghost.getBalanceInfo({ methodArgsOrArgsArray: txns.map(balanceArgs), chunk: false }))
          : ghost.getBalanceInfo({ methodArgsOrArgsArray: balanceArgs([slice]), chunk: options.chunk }),
      (raw) => zipMap(accounts, raw),
      options,
      this.perRequestFor(32, options),
    )
  }

  // ---- auth addresses

  /** The auth (rekeyed-to) address of each account, `undefined` when not rekeyed */
  async getAuthAddrs(accounts: string[], { round, chunk }: ReadOptions = {}): Promise<Map<string, string | undefined>> {
    const ghost = await this.at(round)
    return decodeAuthAddrs(accounts, await this.sliced(accounts, (slice) => ghost.getAuthAddrs({ methodArgsOrArgsArray: { accounts: slice }, chunk, extraSimulateArgs: this.budget() })))
  }

  async getAuthAddrsAtRounds(
    accounts: string[],
    rounds: GhostkitRound[],
    options: AtRoundsOptions = {},
  ): Promise<AtRounds<Map<string, string | undefined>>> {
    return this.atRoundsDecoded(
      rounds,
      accounts,
      (ghost, slice) => ghost.getAuthAddrs({ methodArgsOrArgsArray: { accounts: slice }, chunk: options.chunk }),
      (raw) => decodeAuthAddrs(accounts, raw),
      options,
    )
  }

  // ---- asset holdings

  /** One asset's holding in each account; `undefined` when the account is not opted in */
  async getAssetHoldings(
    assetId: number | bigint,
    accounts: string[],
    { round, chunk }: ReadOptions = {},
  ): Promise<Map<string, AssetHolding | undefined>> {
    assertCreatableId(assetId)
    const ghost = await this.at(round)
    const raw = await this.sliced(accounts, (slice) => ghost.getAssetHoldings({ methodArgsOrArgsArray: { assetId: BigInt(assetId), accounts: slice }, chunk, extraSimulateArgs: this.budget() }))
    return decodeHoldings(accounts, raw)
  }

  async getAssetHoldingsAtRounds(
    assetId: number | bigint,
    accounts: string[],
    rounds: GhostkitRound[],
    options: AtRoundsOptions = {},
  ): Promise<AtRounds<Map<string, AssetHolding | undefined>>> {
    assertCreatableId(assetId)
    return this.atRoundsDecoded(
      rounds,
      accounts,
      (ghost, slice) => ghost.getAssetHoldings({ methodArgsOrArgsArray: { assetId: BigInt(assetId), accounts: slice }, chunk: options.chunk }),
      (raw) => decodeHoldings(accounts, raw),
      options,
    )
  }

  // ---- assets and Abel labels

  /** Name, unit name, decimals and `pv` label of each asset, with the registry when `registryAppId` is set */
  async getAssetsTinyLabels(assetIds: (number | bigint)[], { round, chunk, packing }: ReadOptions = {}): Promise<Map<bigint, AssetTinyLabels>> {
    const ids = assetIds.map(BigInt)
    const ghost = await this.at(round)
    const abelAppId = this.registryAppId ?? 0n
    const raw = await this.sliced(
      ids,
      (slice) =>
        packing
          ? this.packedBatch(ghost, slice, packing, (s, txns) =>
              s.getAssetsTiny({ methodArgsOrArgsArray: txns.map((arrays) => assetArgs(arrays, abelAppId)), chunk: false }),
            )
          : ghost.getAssetsTiny({ methodArgsOrArgsArray: assetArgs([slice], abelAppId), chunk, extraSimulateArgs: this.budget() }),
      this.perRequestFor(8, { chunk, packing }),
    )
    return decodeAssets(ids, raw)
  }

  async getAssetsTinyLabelsAtRounds(
    assetIds: (number | bigint)[],
    rounds: GhostkitRound[],
    options: AtRoundsOptions = {},
  ): Promise<AtRounds<Map<bigint, AssetTinyLabels>>> {
    const ids = assetIds.map(BigInt)
    return this.atRoundsDecoded(
      rounds,
      ids,
      (ghost, slice) =>
        options.packing
          ? packGroups(slice, options.packing).map((txns) =>
              ghost.getAssetsTiny({ methodArgsOrArgsArray: txns.map((arrays) => assetArgs(arrays, this.registryAppId ?? 0n)), chunk: false }),
            )
          : ghost.getAssetsTiny({ methodArgsOrArgsArray: assetArgs([slice], this.registryAppId ?? 0n), chunk: options.chunk }),
      (raw) => decodeAssets(ids, raw),
      options,
      this.perRequestFor(8, options),
    )
  }

  /** All labels of one asset, from the registry app itself */
  async getAssetLabels(assetId: number | bigint): Promise<string[]> {
    if (!this.registryAppId) return []
    const { return: ret } = await this.baseSDK.factory
      .getAppClientById({ appId: this.registryAppId })
      .send.getAssetLabels({ args: { assetId: BigInt(assetId) } })
    return ret ?? []
  }

  /** The ids of every asset in the registry */
  async getAllAssetIDs({ round }: { round?: GhostkitRound } = {}): Promise<bigint[]> {
    if (!this.registryAppId) return []
    // stock algokit-utils would ignore the round and list the latest boxes
    if (round !== undefined) this.requireFork("getAllAssetIDs at a round")
    const names = await this.algorand.app.getBoxNames(this.registryAppId, round !== undefined ? { round } : undefined)
    return names.filter((name) => name.nameRaw.length === 8).map((name) => decodeUint64(name.nameRaw, "bigint"))
  }

  /**
   * Every asset's labels, read straight from the registry's boxes in one request (`include=values`) rather than
   * simulated. Gets all labels, where `getAssetsTinyLabels` only checks `pv`, but no asset params
   */
  async getAllAssetLabels({ round }: { round?: GhostkitRound } = {}): Promise<Map<bigint, string[]>> {
    const boxes = await this.registryBoxes(round)
    return new Map(
      boxes.filter(({ name }) => name.length === 8).map(({ name, value }) => [decodeUint64(name, "bigint"), decodeLabels(value)]),
    )
  }

  /** The registry's label definitions */
  async getAbelLabels({ round }: { round?: GhostkitRound } = {}): Promise<AbelLabel[]> {
    const boxes = await this.registryBoxes(round)
    return boxes
      .filter(({ name }) => name.length === 2)
      .map(({ name, value }) => {
        const [labelName, url, numAssets, numOperators] = LABEL_DESCRIPTOR.decode(value) as [string, string, bigint, bigint]
        return { id: new TextDecoder().decode(name), name: labelName, url, numAssets, numOperators }
      })
  }

  /** Every change to the assets' labels in the registry, oldest first (dtalgorand node only) */
  async getAbelLabelHistory({ minRound, maxRound }: { minRound?: GhostkitRound; maxRound?: GhostkitRound } = {}): Promise<AbelLabelChange[]> {
    const registry = this.requireRegistry()
    const changes: AbelLabelChange[] = []
    for await (const { round, timestamp, boxes } of this.requireFork("getAbelLabelHistory").iterateBoxesVersions(registry, {
      minRound,
      maxRound,
      includeValues: true,
      limit: 1000,
    }))
      for (const box of boxes)
        if (box.name.nameRaw.length === 8)
          changes.push({
            round,
            timestamp,
            assetId: decodeUint64(box.name.nameRaw, "bigint"),
            labels: box.deleted || !box.value ? [] : decodeLabels(box.value),
            deleted: box.deleted,
          })
    return changes
  }

  private async registryBoxes(round?: GhostkitRound): Promise<{ name: Uint8Array; value: Uint8Array }[]> {
    const registry = this.requireRegistry()
    this.requireFork("Reading the Abel registry's boxes")
    // the fork's box listing takes include=values, which algokit-utils' DTAlgodLike doesn't declare
    let request = (this.algorand.client.dtAlgod.getApplicationBoxes(registry) as unknown as BoxListing).include("values").limit(100_000)
    if (round !== undefined) request = request.round(round)
    const boxes: { name: Uint8Array; value: Uint8Array }[] = []
    let next: string | undefined
    do {
      const page = await (next ? request.next(next) : request).do()
      for (const box of page.boxes) boxes.push({ name: box.name, value: box.value ?? new Uint8Array() })
      next = page.nextToken
    } while (next)
    return boxes
  }

  /** The fork's `algorand.dt`, or a clear error with stock algokit-utils, which has none */
  private requireFork(what: string): AlgorandClient["dt"] {
    const dt = (this.algorand as { dt?: AlgorandClient["dt"] }).dt
    if (!dt) throw new Error(`abel-ghost-sdk: ${what} needs the dtalgorand fork of algokit-utils (@d13co/dt-algokit-utils) and a dtalgorand node`)
    return dt
  }

  private requireRegistry(): bigint {
    if (!this.registryAppId) throw new Error("set registryAppId to read the Abel registry")
    return this.registryAppId
  }

  // ---- Tinyman

  /**
   * Tinyman pool info for a batch of pool (LP) escrow accounts: whether the escrow is rekeyed to the Tinyman app
   * account (`validRekey`) and the pool's two asset ids and unit names. Accounts that are not pool escrows come back
   * with `asset1Id: 0n`: a genuine pool always has a non-zero `asset1Id`, since Tinyman orders pairs so ALGO is asset 2.
   */
  async getTinymanInfo(
    lpEscrows: string[],
    tinymanAppId: number | bigint = MAINNET_TINYMAN_V2_APP_ID,
    { round, chunk }: ReadOptions = {},
  ): Promise<Map<string, TinymanInfo>> {
    const ghost = await this.at(round)
    const raw = await this.sliced(lpEscrows, (slice) =>
      ghost.getTinymanInfo({ methodArgsOrArgsArray: { tinymanAppId: BigInt(tinymanAppId), lpEscrows: slice }, chunk, extraSimulateArgs: this.budget() }),
    )
    return zipMap(lpEscrows, raw)
  }

  /** The state of each Tinyman pool: reserves, fees, cumulative prices. `undefined` for an account that is not a pool */
  async getTinymanPoolStates(
    lpEscrows: string[],
    tinymanAppId: number | bigint = MAINNET_TINYMAN_V2_APP_ID,
    { round, chunk }: ReadOptions = {},
  ): Promise<Map<string, TinymanPoolState | undefined>> {
    const ghost = await this.at(round)
    const raw = await this.sliced(lpEscrows, (slice) =>
      ghost.getTinymanPoolStates({ methodArgsOrArgsArray: { tinymanAppId: BigInt(tinymanAppId), lpEscrows: slice }, chunk, extraSimulateArgs: this.budget() }),
    )
    return decodePoolStates(lpEscrows, raw)
  }

  async getTinymanPoolStatesAtRounds(
    lpEscrows: string[],
    rounds: GhostkitRound[],
    tinymanAppId: number | bigint = MAINNET_TINYMAN_V2_APP_ID,
    options: AtRoundsOptions = {},
  ): Promise<AtRounds<Map<string, TinymanPoolState | undefined>>> {
    return this.atRoundsDecoded(
      rounds,
      lpEscrows,
      (ghost, slice) =>
        ghost.getTinymanPoolStates({
          methodArgsOrArgsArray: { tinymanAppId: BigInt(tinymanAppId), lpEscrows: slice },
          chunk: options.chunk,
        }),
      (raw) => decodePoolStates(lpEscrows, raw),
      options,
    )
  }

  /**
   * Every change to one Tinyman pool, oldest first: each swap, mint, burn and fee claim, from the escrow's local state
   * history (dtalgorand node only). Exact, where `getTinymanPoolStatesAtRounds` samples
   */
  async getTinymanPoolHistory(
    lpEscrow: string,
    {
      minRound,
      maxRound,
      tinymanAppId = MAINNET_TINYMAN_V2_APP_ID,
    }: { minRound?: GhostkitRound; maxRound?: GhostkitRound; tinymanAppId?: number | bigint } = {},
  ): Promise<TinymanPoolVersion[]> {
    const appId = BigInt(tinymanAppId)
    const history: TinymanPoolVersion[] = []
    for await (const version of this.requireFork("getTinymanPoolHistory").iterateAccountAppVersions(lpEscrow, appId, {
      minRound,
      maxRound,
      includeValues: true,
      limit: 1000,
    })) {
      const local = version.appsLocalState?.find((state) => state.appId === appId)
      if (!local) continue
      history.push({
        round: version.round,
        timestamp: version.timestamp,
        deleted: local.deleted,
        state: local.state ? poolStateFromLocalState(local.state, version.round, version.timestamp) : undefined,
      })
    }
    return history
  }

  /**
   * Prices and volume of each pool between consecutive `rounds`. Volume comes from the growth of the protocol fees,
   * and an interval in which they were claimed is split until each claim is down to its block, in one request per
   * split on a dtalgorand node
   */
  async getTinymanPriceHistory(
    lpEscrows: string[],
    rounds: GhostkitRound[],
    tinymanAppId: number | bigint = MAINNET_TINYMAN_V2_APP_ID,
    { volume = true }: { volume?: boolean } = {},
  ): Promise<Map<string, TinymanPriceInterval[]>> {
    const sorted = [...new Set(rounds.map(BigInt))].sort(compareBigInt)
    const results = await this.getTinymanPoolStatesAtRounds(lpEscrows, sorted, tinymanAppId)
    // rounds that could not be read are skipped, unless none could
    const reads = results.flatMap((result) => (result.ok ? [result.value] : []))
    const failed = results.find((result) => !result.ok)
    if (!reads.length && failed && !failed.ok) throw failed.error

    // decimals never change, so the latest round's are good for every round
    const assetIds = new Set<bigint>()
    for (const read of reads) for (const state of read.values()) if (state) assetIds.add(state.asset1Id).add(state.asset2Id)
    assetIds.delete(0n)
    const assets = assetIds.size ? await this.getAssetsTinyLabels([...assetIds]) : new Map<bigint, AssetTinyLabels>()
    const decimals = (assetId: bigint) => (assetId === 0n ? 6 : Number(assets.get(assetId)?.decimals ?? 0))

    const parts = await this.splitParts()
    const history = new Map<string, TinymanPriceInterval[]>(lpEscrows.map((escrow) => [escrow, []]))
    await Promise.all(
      lpEscrows.map(async (escrow) => {
        for (let i = 1; i < reads.length; i++) {
          const from = reads[i - 1].get(escrow)
          const to = reads[i].get(escrow)
          if (!from || !to || from.asset1Id !== to.asset1Id || from.asset2Id !== to.asset2Id) continue
          const sameFees = from.totalFeeShare === to.totalFeeShare && from.protocolFeeRatio === to.protocolFeeRatio
          const fees = volume && sameFees ? await this.protocolFeeGrowthAcrossClaims(escrow, BigInt(tinymanAppId), from, to, parts) : undefined
          const interval = priceInterval(from, to, decimals(to.asset1Id), decimals(to.asset2Id), {
            volume: fees && volumeFromProtocolFees(fees, to),
          })
          if (interval) history.get(escrow)!.push(interval)
        }
      }),
    )
    return history
  }

  /** How many parts to split an interval into: one request's worth of rounds on a dtalgorand node, else halves */
  private async splitParts(): Promise<number> {
    const { kind, limits } = await this.getNode()
    return kind === "dt" && limits.maxRounds > 1 ? Math.min(limits.maxRounds, 64) : 2
  }

  /**
   * Protocol fees accrued between two reads of a pool, even when they were claimed in between: an interval whose fees
   * went down is split until each claim is down to the one block it happened in, where the fees after it are what
   * accrued since (the fees of swaps earlier in that same block are lost)
   */
  private async protocolFeeGrowthAcrossClaims(
    escrow: string,
    tinymanAppId: bigint,
    from: TinymanPoolState,
    to: TinymanPoolState,
    parts: number,
  ): Promise<ProtocolFeeGrowth | undefined> {
    const growth = protocolFeeGrowth(from, to)
    if (growth) return growth
    const span = to.round - from.round
    if (span <= 1n) return { asset1: to.asset1ProtocolFees, asset2: to.asset2ProtocolFees }
    const n = BigInt(parts)
    const splits = [...new Set(Array.from({ length: parts - 1 }, (_, i) => from.round + (span * BigInt(i + 1)) / n))].filter(
      (round) => round > from.round && round < to.round,
    )
    const reads = await this.getTinymanPoolStatesAtRounds([escrow], splits, tinymanAppId)
    const points = [from, ...reads.map((read) => (read.ok ? read.value.get(escrow) : undefined)), to]
    if (points.some((point) => !point)) return undefined
    const growths = await Promise.all(
      points.slice(1).map((point, i) => this.protocolFeeGrowthAcrossClaims(escrow, tinymanAppId, points[i]!, point!, parts)),
    )
    if (growths.some((part) => !part)) return undefined
    return growths.reduce<ProtocolFeeGrowth>((sum, part) => ({ asset1: sum.asset1 + part!.asset1, asset2: sum.asset2 + part!.asset2 }), {
      asset1: 0n,
      asset2: 0n,
    })
  }

  // ---- PACT

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
    { round, chunk }: ReadOptions = {},
  ): Promise<Map<bigint, PactInfo>> {
    const ids = pactAppIds.map(BigInt)
    const resolved = await this.resolvePactPoolCreators(creators)
    const ghost = await this.at(round)
    const raw = await this.sliced(ids, (slice) =>
      ghost.getPactInfo({
        methodArgsOrArgsArray: {
          constantProductCreator: resolved.CONSTANT_PRODUCT,
          stableswapCreator: resolved.STABLESWAP,
          managedWeightedCreator: resolved.MANAGED_WEIGHTED,
          pactAppIds: slice,
        },
        chunk,
        extraSimulateArgs: this.budget(),
      }),
    )
    return new Map(raw.map((info, i) => [ids[i], { ...info, type: PACT_POOL_TYPES[Number(info.type)] ?? "" } satisfies PactInfo]))
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
      throw new Error("getPactInfo only knows PACT's pool creators on mainnet; pass `creators` explicitly for this network")
    return MAINNET_PACT_POOL_CREATORS
  }

  // ---- blocks

  /** Timestamp and transaction counter of each block from `firstRound` to `lastRound`, at most ~1,000 rounds */
  async getBlockTimesAndTc(firstRound: number | bigint, lastRound: number | bigint): Promise<BlockRoundTimeAndTc[]> {
    const first = BigInt(firstRound)
    const raw = await (await this.at(lastRound)).getBlockTimesAndTc({ methodArgsOrArgsArray: { firstRound: first, lastRound: BigInt(lastRound) } })
    return raw.map((data, i) => ({ ...data, rnd: first + BigInt(i) }))
  }

  /**
   * The last `span` blocks' timestamps and transaction counters up to each of `rounds`, any distance apart, in as few
   * requests as the node allows: the read is relative to the round it runs at, and each round sees itself as the
   * current one. `span` is at most 1,000, the AVM's block lookback
   */
  async getBlockTimesAndTcAtRounds(
    rounds: GhostkitRound[],
    span: number,
    options: AtRoundsOptions = {},
  ): Promise<AtRounds<BlockRoundTimeAndTc[]>> {
    if (span < 1 || span > 1000) throw new RangeError("span has to be 1 to 1,000 blocks")
    const results = await this.atRoundsDecoded(
      rounds,
      [span],
      (ghost) => ghost.getRecentBlockTimesAndTc({ methodArgsOrArgsArray: { span: BigInt(span) } }),
      (raw) => raw,
      options,
    )
    return results.map((result) =>
      result.ok ? { ...result, value: result.value.map((data, i) => ({ ...data, rnd: result.round - BigInt(span) + 1n + BigInt(i) })) } : result,
    )
  }
}

/**
 * `items` as groups of app calls, each app call `packing.args` arrays of up to `packing.perArg` items: at most 16 app
 * calls and `packing.perGroup` items per group
 */
export function packGroups<T>(items: T[], { perArg, args, perGroup }: ArgPacking): T[][][][] {
  const perTxn = perArg * args
  const groupSize = Math.min(perGroup ?? Infinity, 16 * perTxn)
  const groups: T[][][][] = []
  for (let g = 0; g < items.length; g += groupSize) {
    const groupItems = items.slice(g, g + groupSize)
    const txns: T[][][] = []
    for (let t = 0; t < groupItems.length; t += perTxn) {
      const txnItems = groupItems.slice(t, t + perTxn)
      txns.push(Array.from({ length: Math.ceil(txnItems.length / perArg) }, (_, a) => txnItems.slice(a * perArg, (a + 1) * perArg)))
    }
    groups.push(txns)
  }
  return groups
}

/** The reader's four account arrays, from up to four */
function balanceArgs([accounts = [], accounts2 = [], accounts3 = [], accounts4 = []]: string[][]) {
  return { accounts, accounts2, accounts3, accounts4 }
}

/** The reader's four asset id arrays, from up to four */
function assetArgs([assetIds = [], assetIds2 = [], assetIds3 = [], assetIds4 = []]: bigint[][], abelAppId: bigint) {
  return { assetIds, abelAppId, assetIds2, assetIds3, assetIds4 }
}

function zipMap<K, V>(keys: K[], values: V[]): Map<K, V> {
  return new Map(values.map((value, i) => [keys[i], value]))
}

function decodeAuthAddrs(accounts: string[], raw: string[]): Map<string, string | undefined> {
  // the contract logs the zero address for accounts that are not rekeyed
  return new Map(raw.map((authAddr, i) => [accounts[i], authAddr === ALGORAND_ZERO_ADDRESS_STRING ? undefined : authAddr]))
}

function decodeHoldings(accounts: string[], raw: AssetHolding[]): Map<string, AssetHolding | undefined> {
  return new Map(raw.map((holding, i) => [accounts[i], holding.optedIn ? holding : undefined]))
}

function decodeAssets(ids: bigint[], raw: AssetTinyLabelsInternal[]): Map<bigint, AssetTinyLabels> {
  return new Map(raw.map((asset, i) => [ids[i], { ...asset, id: ids[i] }]))
}

function decodePoolStates(escrows: string[], raw: TinymanPoolStateInternal[]): Map<string, TinymanPoolState | undefined> {
  return new Map(raw.map((state, i) => [escrows[i], state.exists ? poolState(state) : undefined]))
}

function poolState({ exists: _, ts, cumulativePriceUpdateTimestamp, asset1CumulativePrice, asset2CumulativePrice, ...rest }: TinymanPoolStateInternal): TinymanPoolState {
  return {
    ...rest,
    timestamp: Number(ts),
    cumulativePriceUpdateTimestamp: Number(cumulativePriceUpdateTimestamp),
    asset1CumulativePrice: bytesToBigInt(asset1CumulativePrice),
    asset2CumulativePrice: bytesToBigInt(asset2CumulativePrice),
  }
}

/** A pool state from the escrow's Tinyman local state, as `/versions` returns it */
function poolStateFromLocalState(state: AppState, round: bigint, timestamp: number): TinymanPoolState {
  const uint = (key: string) => {
    const entry = state[key]
    return entry && typeof entry.value === "bigint" ? entry.value : 0n
  }
  const bytes = (key: string) => {
    const entry = state[key]
    return entry && "valueRaw" in entry ? bytesToBigInt(entry.valueRaw) : 0n
  }
  return {
    round,
    timestamp,
    // the local state doesn't say; only Tinyman writes it, so the escrow is one of its pools
    validRekey: true,
    asset1Id: uint("asset_1_id"),
    asset2Id: uint("asset_2_id"),
    asset1Reserves: uint("asset_1_reserves"),
    asset2Reserves: uint("asset_2_reserves"),
    issuedPoolTokens: uint("issued_pool_tokens"),
    asset1ProtocolFees: uint("asset_1_protocol_fees"),
    asset2ProtocolFees: uint("asset_2_protocol_fees"),
    totalFeeShare: uint("total_fee_share"),
    protocolFeeRatio: uint("protocol_fee_ratio"),
    cumulativePriceUpdateTimestamp: Number(uint("cumulative_price_update_timestamp")),
    asset1CumulativePrice: bytes("asset_1_cumulative_price"),
    asset2CumulativePrice: bytes("asset_2_cumulative_price"),
  }
}

function decodeLabels(value: Uint8Array): string[] {
  return value.length ? (STRING_ARRAY.decode(value) as string[]) : []
}

function assertCreatableId(id: number | bigint) {
  // ids below 256 cannot be unnamed resources, and the contract logs nothing useful for them
  if (BigInt(id) < 256n) throw new RangeError(`asset id ${id} is below 256, which a ghost read can't reference`)
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

