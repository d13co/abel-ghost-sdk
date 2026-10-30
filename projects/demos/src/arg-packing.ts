// How many items fit in an app call, and does filling it pay? The reader's balance and asset methods take four array
// arguments, since one app arg holds at most 4,096 bytes while an app call can carry more.
//
//   pnpm packing [--reps 3] [--accounts 17000] [--rounds 32]
//
// Layouts, each timed `--reps` times (median):
// - ghostkit's chunking with the method's tag (4 KB of args per app call by default)
// - ghostkit's chunking with 2 KB args, the limit before consensus v42
// - packed by hand into 1, 2 or 4 arrays of up to 4 KB per app call (`packing` option)
// for balances of many accounts (now, and at many rounds) and for every asset of the Abel registry.
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArgPacking, GhostkitChunkOptions } from "abel-ghost-sdk/src/index.js"
import { describe, makeSDK, measure, num, printNode, safeTip, spread, type Measured } from "./lib/node.js"
import { writeReport, type Section } from "./lib/report.js"

interface Layout {
  name: string
  /** items per app call */
  perTxn: number
  chunk?: GhostkitChunkOptions
  packing?: ArgPacking
}

interface Result {
  layout: string
  perTxn: number
  ms: number | null
  simulates: number | null
  note?: string
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

;(async () => {
  const sdk = makeSDK()
  const [nodeLine, tip] = await Promise.all([printNode(sdk), safeTip()])
  const reps = num("reps", 3)

  // accounts: the Tinyman pool escrows the tinyman demo cached, else the registry's assets' creators would do
  let accounts: string[]
  try {
    accounts = JSON.parse(readFileSync(join(tmpdir(), "abel-dt-demos", "tinyman-v2-escrows.json"), "utf8"))
  } catch {
    throw new Error("run `pnpm tinyman --no-global` once first: it caches the Tinyman pool escrows this demo reads balances of")
  }
  accounts = accounts.slice(0, num("accounts", 17_000))
  const rounds = spread(tip - 1_000_000n, tip, num("rounds", 32))
  const roundAccounts = accounts.slice(0, 2000)
  const assetIds = await sdk.getAllAssetIDs()
  console.log(`${accounts.length} accounts now, ${roundAccounts.length} accounts at ${rounds.length} rounds, ${assetIds.length} Abel assets`)

  const run = async (label: string, layout: Layout, f: () => Promise<unknown>): Promise<Result> => {
    const runs: Measured<unknown>[] = []
    try {
      for (let i = 0; i < reps; i++) runs.push(await measure(f))
    } catch (error) {
      const note = (error as Error).message.replace(/^.*?failed[^:]*: /, "").slice(0, 200)
      console.log(`  ${label} ${layout.name}: failed: ${note}`)
      return { layout: layout.name, perTxn: layout.perTxn, ms: null, simulates: null, note }
    }
    const result = { layout: layout.name, perTxn: layout.perTxn, ms: median(runs.map((r) => r.ms)), simulates: runs[0].simulates }
    console.log(`  ${label} ${layout.name}: ${describe(runs[0])}; median ${result.ms} ms`)
    return result
  }

  // ---- balances
  const balanceLayouts: Layout[] = [
    { name: "ghostkit, 2 KB per app call", perTxn: 63, chunk: { arg: "accounts", maxArgBytes: 2048 } },
    { name: "ghostkit default, one 4 KB arg", perTxn: 127 },
    { name: "1 array × 127", perTxn: 127, packing: { perArg: 127, args: 1 } },
    { name: "2 arrays × 127", perTxn: 254, packing: { perArg: 127, args: 2 } },
    { name: "4 arrays × 127", perTxn: 508, packing: { perArg: 127, args: 4 } },
  ]
  const balancesNow: Result[] = []
  const balancesAtRounds: Result[] = []
  for (const layout of balanceLayouts) {
    balancesNow.push(await run(`balances of ${accounts.length}`, layout, () => sdk.getBalanceInfo(accounts, { chunk: layout.chunk, packing: layout.packing })))
    balancesAtRounds.push(
      await run(`balances of ${roundAccounts.length} at ${rounds.length} rounds`, layout, async () => {
        const results = await sdk.getBalanceInfoAtRounds(roundAccounts, rounds, { chunk: layout.chunk, packing: layout.packing })
        const failed = results.find((r) => !r.ok)
        if (failed && !failed.ok) throw failed.error
      }),
    )
  }

  // the packed reads must equal the default ones
  const reference = await sdk.getBalanceInfo(accounts)
  const packed = await sdk.getBalanceInfo(accounts, { packing: { perArg: 127, args: 4 } })
  const sameBalances = accounts.every((a) => reference.get(a)?.balance === packed.get(a)?.balance && reference.get(a)?.minBalance === packed.get(a)?.minBalance)
  console.log(`  4 arrays × 127 vs default: ${sameBalances ? "same balances" : "DIFFERENT balances"}`)

  // ---- Abel assets: each asset makes an inner app call, and a group makes at most 256
  const assetLayouts: Layout[] = [
    { name: "ghostkit tag: 128 per app call and group", perTxn: 128 },
    { name: "ghostkit, 4 KB arg, 256 per group", perTxn: 256, chunk: { arg: "assetIds", refsPerItem: 2, maxPerGroup: 256, maxArgBytes: 4096 } },
    { name: "1 array × 256", perTxn: 256, packing: { perArg: 256, args: 1, perGroup: 256 } },
    { name: "2 arrays × 128", perTxn: 256, packing: { perArg: 128, args: 2, perGroup: 256 } },
    { name: "4 arrays × 64", perTxn: 256, packing: { perArg: 64, args: 4, perGroup: 256 } },
  ]
  const assets: Result[] = []
  for (const layout of assetLayouts)
    assets.push(await run(`${assetIds.length} assets`, layout, () => sdk.getAssetsTinyLabels(assetIds, { chunk: layout.chunk, packing: layout.packing })))

  const best = (results: Result[]) => results.filter((r) => r.ms !== null).sort((a, b) => a.ms! - b.ms!)[0]
  const table = (title: string, subtitle: string, results: Result[]): Section => ({
    kind: "table",
    title,
    subtitle,
    columns: ["layout", "items per app call", "simulate requests", "median ms", "note"],
    rows: results.map((r) => [r === best(results) ? `★ ${r.layout}` : r.layout, r.perTxn, r.simulates ?? "", r.ms ?? "failed", r.note ?? ""]),
  })
  const bars = (title: string, results: Result[]): Section => ({
    kind: "bar",
    title,
    labels: results.map((r) => r.layout),
    yLabel: "median ms",
    horizontal: true,
    series: [{ label: "median ms", values: results.map((r) => r.ms), slot: 0 }],
  })
  const sections: Section[] = [
    bars(`Balances of ${accounts.length.toLocaleString("en-US")} accounts, now`, balancesNow),
    table(`Balances of ${accounts.length.toLocaleString("en-US")} accounts, now`, `Median of ${reps} runs. 4 arrays × 127 and the default read agree: ${sameBalances ? "yes" : "NO"}.`, balancesNow),
    bars(`Balances of ${roundAccounts.length.toLocaleString("en-US")} accounts at ${rounds.length} rounds`, balancesAtRounds),
    table(`Balances of ${roundAccounts.length.toLocaleString("en-US")} accounts at ${rounds.length} rounds`, `The last 1,000,000 rounds. Median of ${reps} runs.`, balancesAtRounds),
    bars(`All ${assetIds.length.toLocaleString("en-US")} Abel assets`, assets),
    table(
      `All ${assetIds.length.toLocaleString("en-US")} Abel assets`,
      `Each asset makes an inner app call to the registry and a group makes at most 256, so filling an app call past 256 can't help. Median of ${reps} runs.`,
      assets,
    ),
    {
      kind: "text",
      title: "How it was read",
      paragraphs: [
        nodeLine + ".",
        "One app arg holds at most 4,096 bytes: 127 addresses or 511 asset ids. ghostkit splits one array argument per app call; the `packing` option spreads the items over the reader's four array arguments, and sends the groups together through ghostkit's `batch` (or `atRounds`). Each request carries at most 2,048 items, well under the node's 1 MB limit.",
      ],
    },
  ]
  const path = writeReport("arg-packing", {
    title: "Packing app args",
    subtitle: "Filling app calls with up to four 4 KB array arguments, against ghostkit's one-array chunking, on a dtalgorand node.",
    stats: [
      { label: "Balances now, fastest", value: `${best(balancesNow)?.ms} ms`, note: best(balancesNow)?.layout },
      { label: "Balances at rounds, fastest", value: `${best(balancesAtRounds)?.ms} ms`, note: best(balancesAtRounds)?.layout },
      { label: "Abel assets, fastest", value: `${best(assets)?.ms} ms`, note: best(assets)?.layout },
    ],
    sections,
    data: { balancesNow, balancesAtRounds, assets },
  })
  console.log(`report: ${path}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
