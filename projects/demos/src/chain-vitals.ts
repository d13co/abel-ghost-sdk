// MainNet's vital signs since genesis: supply, exact online stake, block time and throughput.
//
//   pnpm vitals [--samples 256] [--span 1000] [--supply-samples 256]
//
// - Supply: `GET /v2/ledger/supply?round=` at up to `--supply-samples` of the sampled rounds; a dtalgorand node also reports the exact online
//   stake, without the keys that had expired.
// - Blocks: the reader contract reads the timestamp and transaction counter of the `--span` blocks before each sampled
//   round (`getRecentBlockTimesAndTc`). Its reads are relative to the round it runs at, so the same call runs at every
//   sample, however far apart, and the node takes up to its query `maxRounds` samples per request.
import { describe, measure, num, printNode, queries, safeTip, spread, suppliesAt, makeSDK, algo } from "./lib/node.js"
import { writeReport, type Section } from "./lib/report.js"

;(async () => {
  const sdk = makeSDK({ registry: false })
  const [nodeLine, tip] = await Promise.all([printNode(sdk), safeTip()])
  const span = num("span", 1000)
  const rounds = spread(BigInt(span) + 1n, tip, num("samples", 256))
  console.log(`${rounds.length} rounds from ${rounds[0]} to ${rounds.at(-1)}, ${span} blocks each`)

  const blocks = await measure(() => sdk.getBlockTimesAndTcAtRounds(rounds, span))
  console.log(`blocks: ${(rounds.length * span).toLocaleString("en-US")} block headers in ${describe(blocks)}`)
  const supply = await measure(() => suppliesAt(rounds))
  console.log(`supply at ${supply.result.size} rounds: ${describe(supply)}`)

  const failed = blocks.result.filter((r) => !r.ok)
  if (failed.length) console.log(`${failed.length} rounds failed, e.g. ${failed[0].round}: ${!failed[0].ok && failed[0].error.message}`)
  const notes = new Map<string, number>()
  for (const r of blocks.result) for (const note of r.protocolOverride?.applied ? (r.protocolOverride.notes ?? []) : []) notes.set(note.code, (notes.get(note.code) ?? 0) + 1)

  const rows = blocks.result.flatMap((r) => {
    if (!r.ok) return []
    const headers = r.value
    const first = headers[0]
    const last = headers.at(-1)!
    const seconds = last.ts - first.ts
    const gaps = headers.slice(1).map((h, j) => h.ts - headers[j].ts).sort((a, b) => a - b)
    // the transaction counter only exists from the upgrade that added it; before that it reads 0
    const txns = first.tc > 0n ? Number(last.tc - first.tc) : undefined
    const s = supply.result.get(r.round)
    return [
      {
        round: r.round,
        ts: last.ts,
        blockTime: seconds / (headers.length - 1),
        p99Gap: gaps[Math.floor(gaps.length * 0.99)],
        maxGap: gaps.at(-1)!,
        tps: txns !== undefined && seconds > 0 ? txns / seconds : undefined,
        txnsPerBlock: txns !== undefined ? txns / (headers.length - 1) : undefined,
        supplyRead: supply.result.has(r.round),
        totalMoney: s?.totalMoney,
        onlineMoney: s?.onlineMoney,
        onlineStake: s?.onlineStake,
      },
    ]
  })
  const last = rows.at(-1)!
  // the supply lines only at the rounds it was read at, so they don't break into gaps
  const withSupply = rows.filter((r) => r.supplyRead)
  console.log(
    `latest: ${last.blockTime.toFixed(2)} s blocks, ${last.tps?.toFixed(1)} txn/s, online stake ${last.onlineStake !== undefined ? algo(last.onlineStake).toLocaleString("en-US") : "?"} ALGO`,
  )

  const sections: Section[] = [
    {
      kind: "line",
      title: "Total money and online stake",
      subtitle:
        "Total money leaves out non-participating accounts. Online money counts every online account; the exact online stake (dtalgorand only) leaves out the ones whose participation keys had expired.",
      x: "time",
      yLabel: "ALGO",
      zeroY: true,
      series: [
        { label: "total money", points: withSupply.map((r) => [r.ts, r.totalMoney !== undefined ? algo(r.totalMoney) : null]), slot: 0 },
        { label: "online money", points: withSupply.map((r) => [r.ts, r.onlineMoney !== undefined ? algo(r.onlineMoney) : null]), slot: 1 },
        { label: "online stake (exact)", points: withSupply.map((r) => [r.ts, r.onlineStake !== undefined ? algo(r.onlineStake) : null]), slot: 2 },
      ],
    },
    {
      kind: "line",
      title: "Online money less the exact online stake",
      subtitle:
        "Mostly stake still marked online whose participation keys had expired. The exact online stake is the stake that votes in the round, taken from the balances 320 rounds before it, so the two can also differ by what moved in between, which is why it dips below zero.",
      x: "time",
      yLabel: "ALGO",
      zeroY: true,
      series: [
        {
          label: "expired but online",
          points: withSupply.map((r) => [r.ts, r.onlineMoney !== undefined && r.onlineStake !== undefined ? algo(r.onlineMoney - r.onlineStake) : null]),
          slot: 3,
        },
      ],
    },
    {
      kind: "line",
      title: "Block time",
      subtitle: `Average seconds per block over the ${span} blocks before each sampled round. The first blocks are 25 s apart: the genesis timestamp lay in the past, and a block's timestamp can be at most 25 s after the one before it, so they caught up in steps of 25 s.`,
      x: "time",
      yLabel: "seconds per block",
      zeroY: true,
      series: [{ label: "average", points: rows.map((r) => [r.ts, +r.blockTime.toFixed(3)]), slot: 0 }],
    },
    {
      kind: "line",
      title: "Longest gap between blocks",
      subtitle: `The 99th percentile and the longest gap within each window of ${span} blocks.`,
      x: "time",
      yLabel: "seconds",
      zeroY: true,
      series: [
        { label: "99th percentile", points: rows.map((r) => [r.ts, r.p99Gap]), slot: 0 },
        { label: "longest", points: rows.map((r) => [r.ts, r.maxGap]), slot: 1 },
      ],
    },
    {
      kind: "line",
      title: "Transactions per second",
      subtitle: `From the block header's transaction counter, over the ${span} blocks before each sampled round. The counter starts at an upgrade in 2020; it reads 0 before.`,
      x: "time",
      yLabel: "transactions per second",
      zeroY: true,
      series: [{ label: "txn/s", points: rows.map((r) => [r.ts, r.tps !== undefined ? +r.tps.toFixed(2) : null]), slot: 2 }],
    },
    {
      kind: "table",
      title: "Every sample",
      csv: "samples",
      columns: ["round", "date (UTC)", "s/block", "p99 gap", "max gap", "txn/s", "total money (ALGO)", "online stake (ALGO)"],
      rows: rows.map((r) => [
        String(r.round),
        new Date(r.ts * 1000).toISOString().slice(0, 10),
        r.blockTime.toFixed(2),
        r.p99Gap,
        r.maxGap,
        r.tps?.toFixed(2),
        r.totalMoney !== undefined ? Math.round(algo(r.totalMoney)).toLocaleString("en-US") : "",
        r.onlineStake !== undefined ? Math.round(algo(r.onlineStake)).toLocaleString("en-US") : "",
      ]),
    },
    {
      kind: "text",
      title: "How it was read",
      paragraphs: [
        nodeLine + ".",
        `Blocks: \`sdk.getBlockTimesAndTcAtRounds(rounds, ${span})\` read ${(rounds.length * span).toLocaleString("en-US")} block headers in ${describe(blocks)}. Supply: ${describe(supply)}.`,
        `The reader is AVM 11, so ${blocks.result.filter((r) => r.protocolOverride?.applied).length} of the rounds ran under the latest protocol. What the node noted about them: ${
          [...notes].map(([code, n]) => `\`${code}\` (${n} rounds)`).join(", ") || "nothing"
        }. Block timestamps and transaction counters are read as they were on chain.`,
      ],
    },
  ]
  const path = writeReport("chain-vitals", {
    title: "MainNet vital signs",
    subtitle: `${rows.length} samples from round ${rows[0]?.round} to ${last.round}, each with the ${span} blocks before it, read from a dtalgorand node.`,
    stats: [
      { label: "Block headers read", value: (rows.length * span).toLocaleString("en-US"), note: `${queries(blocks.queries)}, ${(blocks.ms / 1000).toFixed(1)} s (query ${(blocks.queryMs / 1000).toFixed(1)} s)` },
      { label: "Block time now", value: `${last.blockTime.toFixed(2)} s`, note: `was ${rows[0]?.blockTime.toFixed(2)} s at round ${rows[0]?.round}` },
      { label: "Throughput now", value: `${last.tps?.toFixed(1)} txn/s` },
      {
        label: "Online stake now",
        value: last.onlineStake !== undefined ? `${(algo(last.onlineStake) / 1e9).toFixed(2)}B ALGO` : "?",
        note: last.totalMoney !== undefined && last.onlineStake !== undefined ? `${((Number(last.onlineStake) / Number(last.totalMoney)) * 100).toFixed(1)}% of total money` : undefined,
      },
    ],
    sections,
    data: rows,
  })
  console.log(`report: ${path}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
