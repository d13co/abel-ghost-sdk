// Tinyman v2: every pool now and a day ago, and selected pools over time, tick by tick.
//
//   pnpm tinyman [--pools USDC,goBTC,… | --pools <escrow>,…] [--days 7] [--no-global] [--no-compare] [--refresh]
//
// Global: the pool escrows come from an indexer (cached; algod can't list them). The reader contract checks each one
// (rekeyed to Tinyman, which pair) in one chunked call, then reads every pool's state now and a day ago in one
// `atRounds` call, for TVL, 24h price moves and 24h volume. It also times the same pool check on the stock backend.
// Selected pools: every change to the pool (each swap, mint, burn, fee claim) from the escrow's local state
// `/versions`, beside hourly time-weighted prices and volume from the reader at each hour.
import { getApplicationAddress } from "algosdk"
import {
  AbelGhostSDK,
  MAINNET_TINYMAN_V2_APP_ID,
  volumeEstimate,
  type AssetTinyLabels,
  type TinymanPoolState,
  type TinymanPoolVersion,
  type TinymanPriceInterval,
} from "abel-ghost-sdk/src/index.js"
import { cached } from "./lib/cache.js"
import { algoText, describe, flag, INDEXER_SERVER, makeSDK, measure, num, printNode, safeTip, short, str, type Measured } from "./lib/node.js"
import { writeReport, type Section } from "./lib/report.js"

/** pools to pick by the asset paired with ALGO: the one with the most ALGO */
const PRESETS: Record<string, bigint> = {
  USDC: 31566704n,
  USDt: 312769n,
  goBTC: 386192725n,
  goETH: 386195940n,
  xALGO: 1134696561n,
  COOP: 796425061n,
}
/** stablecoins: chart ALGO's price in them, rather than theirs in ALGO */
const STABLE = new Set([31566704n, 312769n])

async function poolEscrows(refresh: boolean): Promise<string[]> {
  const tinyman = getApplicationAddress(MAINNET_TINYMAN_V2_APP_ID).toString()
  return cached(
    "tinyman-v2-escrows",
    async () => {
      const escrows: string[] = []
      let next: string | undefined
      do {
        const url = `${INDEXER_SERVER}/v2/accounts?auth-addr=${tinyman}&limit=1000&exclude=all${next ? `&next=${next}` : ""}`
        const page = (await (await fetch(url)).json()) as { accounts: { address: string }[]; "next-token"?: string }
        escrows.push(...page.accounts.map((a) => a.address))
        next = page.accounts.length ? page["next-token"] : undefined
        process.stdout.write(`\r  listing pool escrows from the indexer: ${escrows.length}`)
      } while (next)
      process.stdout.write("\n")
      return escrows
    },
    { refresh },
  )
}

const decimalsOf = (assets: Map<bigint, AssetTinyLabels>, id: bigint) => (id === 0n ? 6 : Number(assets.get(id)?.decimals ?? 0))
const nameOf = (assets: Map<bigint, AssetTinyLabels>, id: bigint) => (id === 0n ? "ALGO" : assets.get(id)?.unitName || `#${id}`)

/** asset 1's price in ALGO, for an ALGO pair */
function priceInAlgo(state: TinymanPoolState, decimals1: number): number | undefined {
  if (state.asset2Id !== 0n || state.asset1Reserves === 0n) return undefined
  return Number(state.asset2Reserves) / 1e6 / (Number(state.asset1Reserves) / 10 ** decimals1)
}

// ---- what each chart took: items read, requests, time

let readCount = 0

/** Counts the items each of the SDK's Tinyman and asset reads asks for, including those it makes inside other reads */
function countReads(sdk: AbelGhostSDK): AbelGhostSDK {
  const wrap = (name: "getTinymanInfo" | "getTinymanPoolStates" | "getTinymanPoolStatesAtRounds" | "getAssetsTinyLabels", count: (...args: any[]) => number) => {
    const original = (sdk[name] as (...args: any[]) => Promise<unknown>).bind(sdk)
    ;(sdk as any)[name] = (...args: any[]) => {
      readCount += count(...args)
      return original(...args)
    }
  }
  wrap("getTinymanInfo", (escrows: string[]) => escrows.length)
  wrap("getTinymanPoolStates", (escrows: string[]) => escrows.length)
  wrap("getTinymanPoolStatesAtRounds", (escrows: string[], rounds: unknown[]) => escrows.length * rounds.length)
  wrap("getAssetsTinyLabels", (ids: unknown[]) => ids.length)
  return sdk
}

type Costed<T> = Measured<T> & { reads: number }

/** `measure`, plus the items read */
async function costed<T>(f: () => Promise<T>): Promise<Costed<T>> {
  const before = readCount
  const m = await measure(f)
  return { ...m, reads: readCount - before }
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`
const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)

/** "34,590 pool-state reads · 5 simulate requests · 3.2 s" */
function cost(m: Costed<unknown>, what = "read", reads = m.reads): string {
  return [plural(reads, what), m.simulates && plural(m.simulates, "simulate request"), m.versions && plural(m.versions, "/versions request"), seconds(m.ms)]
    .filter(Boolean)
    .join(" · ")
}

;(async () => {
  const sdk = countReads(makeSDK())
  const [nodeLine, tip] = await Promise.all([printNode(sdk), safeTip()])
  // rounds per day, from the last 1,000 blocks
  const recent = await sdk.getBlockTimesAndTc(tip - 999n, tip)
  const blockTime = (recent.at(-1)!.ts - recent[0].ts) / (recent.length - 1)
  const roundsPerDay = BigInt(Math.round(86_400 / blockTime))
  console.log(`latest round ${tip}, ${blockTime.toFixed(2)} s per block, ~${roundsPerDay} rounds per day`)
  const sections: Section[] = []
  const stats: { label: string; value: string; note?: string }[] = []
  const notes: string[] = [nodeLine + "."]

  const escrows = await poolEscrows(flag("refresh"))
  console.log(`${escrows.length} escrows rekeyed to Tinyman v2 (indexer, cached)`)

  // ---- every pool's pair, in one chunked call
  const info = await costed(() => sdk.getTinymanInfo(escrows))
  const pools = escrows.filter((e) => info.result.get(e)!.asset1Id !== 0n && info.result.get(e)!.validRekey)
  console.log(`pool check: ${describe(info)} → ${pools.length} pools`)
  notes.push(`Pool check of ${escrows.length} escrows (\`sdk.getTinymanInfo\`): ${describe(info)}.`)
  stats.push({ label: "Pools", value: pools.length.toLocaleString("en-US"), note: `of ${escrows.length.toLocaleString("en-US")} escrows` })
  stats.push({ label: "Pool check", value: `${(info.ms / 1000).toFixed(1)} s`, note: `${info.simulates} simulate requests` })

  if (!flag("no-compare")) {
    const subset = escrows.slice(0, 2000)
    const dt = await costed(() => sdk.getTinymanInfo(subset))
    const stock = await costed(() => countReads(makeSDK({ stock: true })).getTinymanInfo(subset))
    console.log(`  ${subset.length} escrows: dtalgorand ${describe(dt)}; stock ${describe(stock)}`)
    sections.push({
      kind: "table",
      title: `Checking ${subset.length.toLocaleString("en-US")} escrows: dtalgorand vs stock simulate`,
      cost: `dtalgorand: ${cost(dt, "pool check")} — stock: ${cost(stock, "pool check")}`,
      subtitle:
        "Same reader, same escrows, same node. The stock backend sends one group per request, with 128 resources per group; the dtalgorand backend sends up to 16 groups per request, with 128× the resources. On a fast link the stock backend's 8 concurrent requests keep up; the difference is in requests, and in latency on a slow link.",
      columns: ["backend", "simulate requests", "wall time (ms)", "median request (ms)"],
      rows: [
        ["dtalgorand", dt.simulates, dt.ms, dt.simulateMedianMs],
        ["stock", stock.simulates, stock.ms, stock.simulateMedianMs],
      ],
    })
  }

  // ---- global: every pool now and a day ago
  let poolTable: Section | undefined
  if (!flag("no-global")) {
    const dayAgo = tip - roundsPerDay
    const states = await costed(() => sdk.getTinymanPoolStatesAtRounds(pools, [dayAgo, tip]))
    console.log(`pool states now and a day ago: ${describe(states)}`)
    notes.push(`Pool states of ${pools.length} pools at rounds ${dayAgo} and ${tip} (\`sdk.getTinymanPoolStatesAtRounds\`): ${describe(states)}.`)
    stats.push({ label: "Pool states", value: `${(states.ms / 1000).toFixed(1)} s`, note: `${(pools.length * 2).toLocaleString("en-US")} reads, ${states.simulates} simulates` })
    const [then, now] = states.result.map((r) => {
      if (!r.ok) throw r.error
      return r.value
    })
    const algoPools = pools.filter((p) => now.get(p)?.asset2Id === 0n)
    const tvl = (s: TinymanPoolState | undefined) => (s && s.asset2Id === 0n ? s.asset2Reserves * 2n : 0n)
    const byTvl = [...algoPools].sort((a, b) => (tvl(now.get(b)) > tvl(now.get(a)) ? 1 : -1))
    const totalTvl = algoPools.reduce((sum, p) => sum + tvl(now.get(p)), 0n)
    stats.push({ label: "TVL of ALGO pairs", value: `${algoText(totalTvl)} ALGO`, note: `${algoPools.length.toLocaleString("en-US")} pools` })

    const liquid = byTvl.filter((p) => tvl(now.get(p)) >= 20_000_000_000n)
    const assetIds = [...new Set(liquid.map((p) => now.get(p)!.asset1Id))]
    const assetRead = await costed(() => sdk.getAssetsTinyLabels(assetIds))
    const assets = assetRead.result
    // every global chart comes from the same two reads, after the pool check
    const globalCost = `${cost(states, "pool-state read")}, then ${cost(assetRead, "asset read")}`
    const rows = liquid.map((p) => {
      const a = now.get(p)!
      const b = then.get(p)
      const d1 = decimalsOf(assets, a.asset1Id)
      const priceNow = priceInAlgo(a, d1)
      const priceThen = b && priceInAlgo(b, d1)
      const volume = b && volumeEstimate(b, a)
      // both sides of the volume, in ALGO: asset 1's at today's price
      const volumeAlgo = volume && priceNow !== undefined ? Number(volume.asset2) / 1e6 + (Number(volume.asset1) / 10 ** d1) * priceNow : undefined
      return {
        escrow: p,
        pair: `${nameOf(assets, a.asset1Id)}/ALGO`,
        verified: assets.get(a.asset1Id)?.labels.includes("pv") ?? false,
        tvl: Number(tvl(a)) / 1e6,
        priceNow,
        change: priceNow !== undefined && priceThen ? (priceNow / priceThen - 1) * 100 : undefined,
        volumeAlgo,
      }
    })
    const top = rows.slice(0, 20)
    sections.push({
      kind: "bar",
      title: "Largest ALGO pools by TVL",
      cost: globalCost,
      subtitle: "TVL is twice the ALGO side of the pool. `✓` marks assets the Abel registry labels Pera Verified (`pv`), read in the same reader.",
      labels: top.map((r) => `${r.pair}${r.verified ? " ✓" : ""}`),
      yLabel: "ALGO",
      horizontal: true,
      series: [{ label: "TVL", values: top.map((r) => r.tvl), slot: 0 }],
    })
    const movers = rows.filter((r) => r.change !== undefined).sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!)).slice(0, 15)
    sections.push({
      kind: "bar",
      title: "Biggest 24h price moves",
      cost: globalCost,
      subtitle: "Among ALGO pools with at least 10,000 ALGO on each side: the asset's price in ALGO now vs a day ago, from the two reads.",
      labels: movers.map((r) => r.pair),
      yLabel: "% change in ALGO",
      horizontal: true,
      series: [{ label: "24h change", values: movers.map((r) => +r.change!.toFixed(2)), slot: 1 }],
    })
    const busiest = rows.filter((r) => r.volumeAlgo !== undefined).sort((a, b) => b.volumeAlgo! - a.volumeAlgo!).slice(0, 15)
    sections.push({
      kind: "bar",
      title: "Busiest pools, last 24h",
      cost: globalCost,
      subtitle:
        "Swap volume estimated from the growth of the pool's protocol fees between the two reads. Pools whose fees were claimed in between are left out (see the selected pools below for the exact way).",
      labels: busiest.map((r) => r.pair),
      yLabel: "ALGO",
      horizontal: true,
      series: [{ label: "24h volume", values: busiest.map((r) => Math.round(r.volumeAlgo!)), slot: 2 }],
    })
    poolTable = {
      kind: "table",
      title: "ALGO pools with at least 10,000 ALGO",
      cost: globalCost,
      csv: "pools",
      columns: ["pair", "pv", "escrow", "TVL (ALGO)", "price (ALGO)", "24h change %", "24h volume (ALGO)"],
      rows: rows.map((r) => [
        r.pair,
        r.verified ? "✓" : "",
        `\`${r.escrow}\``,
        Math.round(r.tvl).toLocaleString("en-US"),
        r.priceNow === undefined ? "" : +r.priceNow.toPrecision(6),
        r.change === undefined ? "" : r.change.toFixed(2),
        r.volumeAlgo === undefined ? "" : Math.round(r.volumeAlgo).toLocaleString("en-US"),
      ]),
    }
  }

  // ---- selected pools over time
  const days = num("days", 7)
  const picks = (str("pools") ?? "USDC,goBTC,xALGO").split(",").map((s) => s.trim())
  const latest = await sdk.getTinymanPoolStates(pools)
  const selected = picks
    .map((pick) => {
      if (pick.length === 58) return pick
      const assetId = PRESETS[pick] ?? BigInt(pick)
      return pools
        .filter((p) => latest.get(p)?.asset1Id === assetId && latest.get(p)?.asset2Id === 0n)
        .sort((a, b) => (latest.get(b)!.asset2Reserves > latest.get(a)!.asset2Reserves ? 1 : -1))[0]
    })
    .filter((p): p is string => !!p)
  const fromRound = tip - BigInt(days) * roundsPerDay
  const hours = Math.min(days * 24, 255)
  const hourly = Array.from({ length: hours + 1 }, (_, i) => fromRound + ((tip - fromRound) * BigInt(i)) / BigInt(hours))
  console.log(`selected pools ${selected.map(short).join(", ")}: ${days} days, ${hours} intervals`)

  // one pool at a time, so each chart's cost is its own
  // hourly prices are read twice: without volume (one read per hour), and with volume, which splits every hour in
  // which the pool's protocol fees were claimed until it finds the claim's block
  const histories: Costed<TinymanPoolVersion[]>[] = []
  const prices: Costed<Map<string, TinymanPriceInterval[]>>[] = []
  const hourlies: Costed<Map<string, TinymanPriceInterval[]>>[] = []
  for (const escrow of selected) {
    const history = await costed(() => sdk.getTinymanPoolHistory(escrow, { minRound: fromRound, maxRound: tip }))
    histories.push(history)
    const plain = await costed(() => sdk.getTinymanPriceHistory([escrow], hourly, MAINNET_TINYMAN_V2_APP_ID, { volume: false }))
    prices.push(plain)
    const withVolume = await costed(() => sdk.getTinymanPriceHistory([escrow], hourly))
    hourlies.push(withVolume)
    console.log(`  ${short(escrow)}: exact ${cost(history, "change", history.result.length)}; hourly prices ${cost(plain)}; with volume ${cost(withVolume)}`)
  }
  // every selected pool's hourly prices at once: the same rounds, so they share requests
  const together = await costed(() => sdk.getTinymanPriceHistory(selected, hourly, MAINNET_TINYMAN_V2_APP_ID, { volume: false }))
  console.log(`  all ${selected.length} pools' hourly prices together: ${cost(together)}`)
  notes.push(
    `Selected pools: every change over ${days} days from \`/v2/accounts/{escrow}/applications/${MAINNET_TINYMAN_V2_APP_ID}/versions\` (\`sdk.getTinymanPoolHistory\`), and ${hours} hourly intervals from the reader at each hour (\`sdk.getTinymanPriceHistory\`; intervals with a fee claim are split until the claim's block is found, which adds reads). Each chart lists what its reads took.`,
  )
  const assets = await sdk.getAssetsTinyLabels([...new Set(selected.map((p) => latest.get(p)!.asset1Id))])

  const checks = { compared: 0, matched: 0 }
  const twapChecks = { compared: 0, matched: 0 }
  selected.forEach((escrow, i) => {
    const state = latest.get(escrow)!
    const id = state.asset1Id
    const d1 = decimalsOf(assets, id)
    const name = nameOf(assets, id)
    const stable = STABLE.has(id)
    const unit = stable ? `${name} per ALGO` : `ALGO per ${name}`
    const price = (s: TinymanPoolState) => {
      const p = priceInAlgo(s, d1)
      return p === undefined ? null : stable ? 1 / p : p
    }
    const ticks: TinymanPoolVersion[] = histories[i].result
    const priceIntervals: TinymanPriceInterval[] = prices[i].result.get(escrow) ?? []
    const intervals: TinymanPriceInterval[] = hourlies[i].result.get(escrow) ?? []
    // both reads must give the same prices: volume only adds reads between the hours
    for (const [j, t] of priceIntervals.entries()) {
      twapChecks.compared++
      if (t.asset1Twap === intervals[j]?.asset1Twap && t.asset2Twap === intervals[j]?.asset2Twap) twapChecks.matched++
    }
    // the reader's reserves at each hour must equal the last exact change before it
    for (const interval of priceIntervals) {
      const last = [...ticks].reverse().find((t) => t.round <= interval.toRound)
      if (!last?.state) continue
      checks.compared++
      if (last.state.asset1Reserves === interval.asset1Reserves && last.state.asset2Reserves === interval.asset2Reserves) checks.matched++
    }
    const twap = (t: TinymanPriceInterval) => (stable ? t.asset2Twap : t.asset1Twap)
    sections.push({
      kind: "line",
      title: `${name}/ALGO price: ${ticks.length.toLocaleString("en-US")} changes in ${days} days`,
      cost: `exact: ${cost(histories[i], "change", ticks.length)} — hourly, without volume: ${cost(prices[i])}`,
      subtitle: `Escrow \`${escrow}\`. The line is the spot price after every change to the pool; the dots are the hourly time-weighted average price from the pool's own oracle.`,
      x: "time",
      yLabel: unit,
      series: [
        { label: "spot, every change", points: ticks.flatMap((t) => (t.state ? [[t.timestamp, price(t.state)] as [number, number | null]] : [])), step: true, slot: 0 },
        { label: "hourly TWAP", points: priceIntervals.map((t) => [t.toTimestamp, twap(t)]), dots: true, slot: 1 },
      ],
    })
    sections.push({
      kind: "bar",
      title: `${name}/ALGO: hourly swap volume`,
      cost: `hourly, with volume: ${cost(hourlies[i])}`,
      subtitle:
        "Both sides of each hour's swaps, in ALGO, from the growth of the protocol fees. An hour in which the fees were claimed is split until the claim's block is found, which is where the extra reads go.",
      labels: intervals.map((t) => new Date(t.toTimestamp * 1000).toISOString().slice(5, 13).replace("T", " ") + "h"),
      yLabel: "ALGO",
      series: [{ label: "volume", values: intervals.map((t) => (t.volumeInAsset2 === undefined ? null : Math.round(t.volumeInAsset2))), slot: 2 }],
    })
  })
  console.log(`  hourly reader reserves vs exact history: ${checks.matched}/${checks.compared} match`)
  console.log(`  hourly prices without vs with volume: ${twapChecks.matched}/${twapChecks.compared} match`)
  sections.push({
    kind: "table",
    title: "Hourly reads with and without volume",
    subtitle: `${hours} hourly intervals per pool. Prices alone take one read per hour, and the node takes ${hours + 1} rounds in one request; volume also reads inside every hour whose protocol fees were claimed. Both reads give the same prices: ${twapChecks.matched}/${twapChecks.compared} intervals match.`,
    columns: ["pool", "prices: reads", "prices: simulate requests", "prices: time", "with volume: reads", "with volume: simulate requests", "with volume: time"],
    rows: [
      ...selected.map((escrow, i) => [
        `${nameOf(assets, latest.get(escrow)!.asset1Id)}/ALGO`,
        prices[i].reads,
        prices[i].simulates,
        seconds(prices[i].ms),
        hourlies[i].reads,
        hourlies[i].simulates,
        seconds(hourlies[i].ms),
      ]),
      [`all ${selected.length} together`, together.reads, together.simulates, seconds(together.ms), "", "", ""],
    ],
  })
  stats.push({ label: "Hourly reads vs history", value: `${checks.matched}/${checks.compared}`, note: "reserves match" })

  if (poolTable) sections.push(poolTable)
  sections.push({ kind: "text", title: "How it was read", paragraphs: notes })
  const path = writeReport("tinyman-pools", {
    title: "Tinyman v2 pools",
    subtitle: `Every Tinyman v2 pool on MainNet at round ${tip} and a day before, and ${selected.length} pools over ${days} days, read from a dtalgorand node.`,
    stats,
    sections,
  })
  console.log(`report: ${path}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
