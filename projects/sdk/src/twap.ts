/**
 * Tinyman v2 pool state, read by the reader contract at any round or decoded from the escrow's local state versions,
 * plus the price oracle math on top of it.
 *
 * Tinyman keeps a Uniswap v2 style oracle in each pool escrow's local state: before every operation it
 * adds `price * seconds since last update` to `asset_x_cumulative_price`, in 2^64 fixed point, using the
 * reserves from before that operation. The cumulative values are byte ints that only ever grow (AVM byte
 * math does not wrap), so the time-weighted average price between two reads is just
 * `Δcumulative / (Δseconds * 2^64)`.
 */

const TWO_TO_THE_64 = 1n << 64n

/** One pool escrow's Tinyman v2 local state at a round */
export interface TinymanPoolState {
  /** the round this state is as of (the end of) */
  round: bigint
  /** block timestamp of `round`, unix seconds */
  timestamp: number
  /** the escrow is rekeyed to the Tinyman app account, as every genuine pool escrow is */
  validRekey: boolean
  asset1Id: bigint
  /** 0 = ALGO. Tinyman orders pairs so ALGO is always asset 2 */
  asset2Id: bigint
  asset1Reserves: bigint
  asset2Reserves: bigint
  issuedPoolTokens: bigint
  /** unclaimed protocol fees, in asset 1. Grows with every swap that pays in asset 1; reset to 0 on claim */
  asset1ProtocolFees: bigint
  asset2ProtocolFees: bigint
  /** total swap fee, in basis points */
  totalFeeShare: bigint
  /** protocol fee = total fee / this */
  protocolFeeRatio: bigint
  /** unix seconds the cumulative prices were last brought up to date */
  cumulativePriceUpdateTimestamp: number
  /** raw oracle value: Σ (asset 1 price in asset 2 base units) * seconds, in 2^64 fixed point */
  asset1CumulativePrice: bigint
  asset2CumulativePrice: bigint
}

/** Prices and volume between two reads of the same pool */
export interface TinymanPriceInterval {
  fromRound: bigint
  toRound: bigint
  fromTimestamp: number
  toTimestamp: number
  /** time-weighted average price of asset 1, in asset 2, over the interval */
  asset1Twap: number
  /** time-weighted average price of asset 2, in asset 1, over the interval. For ALGO/USDC this is ALGOUSD */
  asset2Twap: number
  /** spot price of asset 1, in asset 2, at `toRound` */
  asset1Spot: number
  asset2Spot: number
  /** reserves at `toRound`, in base units */
  asset1Reserves: bigint
  asset2Reserves: bigint
  /**
   * Estimated swap input volume over the interval, in asset 1 / asset 2 (whole units), from the growth of the
   * protocol fees. `undefined` when it can't be told, e.g. the fee settings changed.
   */
  asset1VolumeIn?: number
  asset2VolumeIn?: number
  /** both sides' volume in asset 2 terms: `asset2VolumeIn + asset1VolumeIn * asset1Twap` */
  volumeInAsset2?: number
}

/**
 * The cumulative prices brought forward to `state.timestamp`. An operation in block `round + 1` sees
 * `LatestTimestamp` = that same timestamp, so this is exactly what Tinyman would store then: same integer
 * math and conditions as its `update_price_oracle`.
 */
export function cumulativePricesAt(state: TinymanPoolState): { asset1: bigint; asset2: bigint } {
  const { asset1Reserves: r1, asset2Reserves: r2 } = state
  const dt = BigInt(state.timestamp - state.cumulativePriceUpdateTimestamp)
  let asset1 = state.asset1CumulativePrice
  let asset2 = state.asset2CumulativePrice
  // Tinyman only checks issued_pool_tokens; the reserves check just keeps an empty pool from dividing by 0
  if (state.issuedPoolTokens > 0n && dt > 0n && r1 > 0n && r2 > 0n) {
    asset1 += (r2 * TWO_TO_THE_64 * dt) / r1
    asset2 += (r1 * TWO_TO_THE_64 * dt) / r2
  }
  return { asset1, asset2 }
}

/** Time-weighted average prices between two reads of the same pool, in base units. `undefined` if no time passed */
export function twap(from: TinymanPoolState, to: TinymanPoolState): { asset1: number; asset2: number } | undefined {
  const dt = BigInt(to.timestamp - from.timestamp)
  if (dt <= 0n) return undefined
  const a = cumulativePricesAt(from)
  const b = cumulativePricesAt(to)
  const denominator = dt * TWO_TO_THE_64
  return { asset1: ratio(b.asset1 - a.asset1, denominator), asset2: ratio(b.asset2 - a.asset2, denominator) }
}

/** Protocol fees accrued per asset, in base units */
export interface ProtocolFeeGrowth {
  asset1: bigint
  asset2: bigint
}

/**
 * Protocol fees accrued between two reads, from their end states alone. `undefined` when either side went
 * down, i.e. the fees were claimed (reset to 0) in between: see `getTinymanPriceHistory`, which then splits
 * the interval to find the claim.
 *
 * A claim followed by more new fees than were claimed can't be told from the end states and undercounts,
 * so the closer the reads, the better: Tinyman pools are claimed every few hours these days.
 */
export function protocolFeeGrowth(from: TinymanPoolState, to: TinymanPoolState): ProtocolFeeGrowth | undefined {
  const asset1 = to.asset1ProtocolFees - from.asset1ProtocolFees
  const asset2 = to.asset2ProtocolFees - from.asset2ProtocolFees
  return asset1 < 0n || asset2 < 0n ? undefined : { asset1, asset2 }
}

/**
 * Swap input volume, in base units, that accrued `fees` under `state`'s fee settings: each swap adds
 * `floor(floor(input * totalFeeShare / 10000) / protocolFeeRatio)` of its input asset. Inverting that
 * slightly undercounts (the floors), and also counts the fees of flash loans and flash swaps.
 */
export function volumeFromProtocolFees(fees: ProtocolFeeGrowth, state: TinymanPoolState): ProtocolFeeGrowth | undefined {
  if (state.totalFeeShare === 0n || state.protocolFeeRatio === 0n) return undefined
  const toVolume = (fee: bigint) => (fee * state.protocolFeeRatio * 10_000n) / state.totalFeeShare
  return { asset1: toVolume(fees.asset1), asset2: toVolume(fees.asset2) }
}

/** `volumeFromProtocolFees(protocolFeeGrowth(from, to))`, if the fee settings did not change in between */
export function volumeEstimate(from: TinymanPoolState, to: TinymanPoolState): ProtocolFeeGrowth | undefined {
  const fees = protocolFeeGrowth(from, to)
  if (!fees || from.totalFeeShare !== to.totalFeeShare || from.protocolFeeRatio !== to.protocolFeeRatio) return undefined
  return volumeFromProtocolFees(fees, to)
}

/**
 * Prices and volume between two reads of the same pool, adjusted to whole units with the assets' decimals.
 * `undefined` when the two reads are not of the same pair or no time passed. `volume` (base units) replaces
 * the end-state `volumeEstimate`, e.g. with one that accounts for fee claims; `{ volume: undefined }` = unknown.
 */
export function priceInterval(
  from: TinymanPoolState,
  to: TinymanPoolState,
  asset1Decimals: number,
  asset2Decimals: number,
  { volume }: { volume: ProtocolFeeGrowth | undefined } = { volume: volumeEstimate(from, to) },
): TinymanPriceInterval | undefined {
  if (from.asset1Id !== to.asset1Id || from.asset2Id !== to.asset2Id) return undefined
  const prices = twap(from, to)
  if (!prices) return undefined
  // a price in base units of asset 2 per base unit of asset 1 -> whole units: * 10^(decimals1 - decimals2)
  const scale1 = 10 ** (asset1Decimals - asset2Decimals)
  const scale2 = 1 / scale1
  const asset1VolumeIn = volume && Number(volume.asset1) / 10 ** asset1Decimals
  const asset2VolumeIn = volume && Number(volume.asset2) / 10 ** asset2Decimals
  const asset1Twap = prices.asset1 * scale1
  return {
    fromRound: from.round,
    toRound: to.round,
    fromTimestamp: from.timestamp,
    toTimestamp: to.timestamp,
    asset1Twap,
    asset2Twap: prices.asset2 * scale2,
    asset1Spot: to.asset1Reserves > 0n ? ratio(to.asset2Reserves, to.asset1Reserves) * scale1 : 0,
    asset2Spot: to.asset2Reserves > 0n ? ratio(to.asset1Reserves, to.asset2Reserves) * scale2 : 0,
    asset1Reserves: to.asset1Reserves,
    asset2Reserves: to.asset2Reserves,
    asset1VolumeIn,
    asset2VolumeIn,
    volumeInAsset2:
      asset1VolumeIn === undefined || asset2VolumeIn === undefined ? undefined : asset2VolumeIn + asset1VolumeIn * asset1Twap,
  }
}

/**
 * Volume-weighted average of `asset2Twap` across intervals, weighted by `volumeInAsset2`. Intervals can come
 * from several pools of the same pair. Intervals with unknown volume are skipped; `undefined` if none are left.
 */
export function vwap(intervals: TinymanPriceInterval[]): number | undefined {
  let weighted = 0
  let volume = 0
  for (const { asset2Twap, volumeInAsset2 } of intervals) {
    if (volumeInAsset2 === undefined) continue
    weighted += asset2Twap * volumeInAsset2
    volume += volumeInAsset2
  }
  return volume > 0 ? weighted / volume : undefined
}

/** `from, from + step, …` up to and including `to` */
export function roundRange(from: number | bigint, to: number | bigint, step: number | bigint): bigint[] {
  const [start, end, by] = [BigInt(from), BigInt(to), BigInt(step)]
  if (by <= 0n) throw new Error("roundRange step has to be positive")
  const rounds: bigint[] = []
  for (let round = start; round <= end; round += by) rounds.push(round)
  return rounds
}

/** A big-endian unsigned integer */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

/** n / d as a float, keeping full double precision however large or small the quotient is */
function ratio(n: bigint, d: bigint): number {
  if (n === 0n) return 0
  if (n < 0n) return -ratio(-n, d)
  // shift so the integer quotient carries ~64 significant bits, then undo the shift in float space
  const shift = 64 - (n.toString(2).length - d.toString(2).length)
  const quotient = shift >= 0 ? (n << BigInt(shift)) / d : n / (d << BigInt(-shift))
  return Number(quotient) * 2 ** -shift
}
