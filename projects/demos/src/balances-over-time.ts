// Algo balances of a set of accounts over the whole chain history: the MainNet genesis accounts by default, or any.
//
//   pnpm balances [--genesis | addr|addrs.txt … | --file addrs.txt] [--from 1] [--to <tip>] [--samples 256] [--top 4]
//                 [--max-versions 20000] [--supply-samples 256]
//
// Two views of a dtalgorand node:
// - sampled: the reader contract runs at `--samples` rounds spread from `--from` to `--to`, a multiple of the rounds
//   the node takes per simulate (256 on the d13 node). The rounds are dealt into that many parts, each spanning the
//   whole range, and each part is one simulate request, all sent at once: ghostkit moves the transactions' validity
//   window to each round, and runs rounds older than the reader's AVM version under the latest protocol.
// - exact: every change to each of the top accounts' balance, from `/v2/accounts/{addr}/versions`.
// It also reads the total and online supply at up to `--supply-samples` of the sampled rounds (one request each), and checks a few sampled balances against
// `GET /v2/accounts/{addr}?round=`.
import { existsSync, readFileSync } from "node:fs"
import type { AtRounds, BalanceInfo } from "abel-ghost-sdk/src/index.js"
import { algo, algorand, algoText, args, describe, flag, makeSDK, mapLimit, measure, num, printNode, safeTip, short, spread, str, suppliesAt } from "./lib/node.js"
import { writeReport, type LineSeries, type Section } from "./lib/report.js"

interface Account {
  address: string
  label: string
  genesis?: bigint
}

/** the genesis accounts and what each held, read once */
let genesis: Promise<Account[]> | undefined
const genesisAccounts = () =>
  (genesis ??= (async () => {
    const raw = await algorand.client.algod.genesis().do()
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    return (parsed.alloc as { addr: string; comment: string; state: { algo?: number } }[]).map(({ addr, comment, state }) => ({
      address: addr,
      label: comment || short(addr),
      genesis: BigInt(state.algo ?? 0),
    }))
  })())

/** `rounds` dealt into `parts` interleaved parts, so each part spans the whole range and the requests take about as long */
const deal = (rounds: bigint[], parts: number) => Array.from({ length: parts }, (_, k) => rounds.filter((_, i) => i % parts === k))

/** runs `read` on every part at once, one simulate request each, and returns the results in round order */
async function inParallel<T>(parts: bigint[][], read: (rounds: bigint[]) => Promise<AtRounds<T>>): Promise<AtRounds<T>> {
  const results = (await Promise.all(parts.map(read))).flat()
  return results.sort((a, b) => (a.round < b.round ? -1 : a.round > b.round ? 1 : 0))
}

;(async () => {
  const sdk = makeSDK({ registry: false })
  // independent startup reads, at once: the node and its limits (and the SDK's suggested params), the tip, the genesis
  const [nodeLine, tip, genesisAlloc] = await Promise.all([printNode(sdk), safeTip(), genesisAccounts()])
  // addresses from --file and the positional arguments; a positional argument naming a file reads its addresses too,
  // since `npm run balances --file x` hands --file to npm and only x reaches the script
  const readAddresses = (path: string) => readFileSync(path, "utf8").split(/\s+/).filter(Boolean)
  const file = str("file")
  const given = [...(file ? readAddresses(file) : []), ...args.positional.flatMap((a) => (existsSync(a) ? readAddresses(a) : [a]))]
  const isGenesis = !given.length || flag("genesis")
  const accounts: Account[] = isGenesis ? genesisAlloc : given.map((address) => ({ address, label: short(address) }))
  // the supply is fixed at genesis: everything the genesis accounts held
  const fixedSupply = genesisAlloc.reduce((sum, a) => sum + (a.genesis ?? 0n), 0n)
  const from = BigInt(num("from", 1))
  const to = BigInt(str("to") ?? tip)
  // rounds per simulate request: the node's limit, or all of them on a node without multi-round simulate (--stock)
  const { limits } = await sdk.getBackend()
  const samples = num("samples", limits.maxRounds || 256)
  const perRequest = limits.maxRounds || samples
  if (!Number.isInteger(samples) || samples < perRequest || samples % perRequest !== 0) {
    console.error(`--samples must be a multiple of ${perRequest}, the rounds the node takes per simulate request (got ${args.flags.get("samples")})`)
    process.exit(1)
  }
  const rounds = spread(from, to, samples)
  const parts = deal(rounds, samples / perRequest)
  console.log(
    `${accounts.length} ${isGenesis ? "genesis " : ""}accounts at ${rounds.length} rounds from ${rounds[0]} to ${rounds.at(-1)}` +
      (parts.length > 1 ? `, in ${parts.length} parallel requests of ${perRequest} rounds` : ""),
  )

  // ---- sampled: balances and block timestamps at every round, one request per part, the parts in parallel
  const addresses = accounts.map((a) => a.address)
  const sampled = await measure(() => inParallel(parts, (part) => sdk.getBalanceInfoAtRounds(addresses, part)))
  console.log(`sampled balances: ${describe(sampled)}`)
  const times = await measure(() => inParallel(parts, (part) => sdk.getBlockTimesAndTcAtRounds(part, 1)))
  console.log(`block timestamps: ${describe(times)}`)
  const timestamp = new Map(times.result.flatMap((r) => (r.ok ? [[r.round, r.value[0].ts] as const] : [])))

  const failed = sampled.result.filter((r) => !r.ok)
  if (failed.length) console.log(`${failed.length} rounds failed, e.g. ${failed[0].round}: ${!failed[0].ok && failed[0].error.message}`)
  const ok = sampled.result.flatMap((r) => (r.ok && timestamp.has(r.round) ? [{ round: r.round, ts: timestamp.get(r.round)!, balances: r.value }] : []))

  // which rounds ran under a later protocol, and what the node noted about them
  const overrides = new Map<string, { rounds: number; first: bigint; last: bigint; notes: Set<string> }>()
  for (const r of sampled.result) {
    const o = r.protocolOverride
    if (!o) continue
    const key = o.applied ? `${o.from.split("/").pop()!.slice(0, 8)} → ${o.to.split("/").pop()!.slice(0, 8)}` : "own protocol (no override needed)"
    const entry = overrides.get(key) ?? { rounds: 0, first: r.round, last: r.round, notes: new Set<string>() }
    entry.rounds++
    entry.last = r.round
    for (const note of o.notes ?? []) entry.notes.add(note.code)
    overrides.set(key, entry)
  }
  for (const [key, { rounds: n, first, last, notes }] of overrides)
    console.log(`  ${n} rounds (${first}–${last}): ${key}${notes.size ? `, notes: ${[...notes].join(", ")}` : ""}`)

  // ---- supply at (some of) the same rounds
  const supplyRun = await measure(() => suppliesAt(ok.map((p) => p.round)))
  console.log(`supply at ${supplyRun.result.size} rounds: ${describe(supplyRun)}`)
  const supply = supplyRun.result

  // ---- per round totals
  const total = (balances: Map<string, BalanceInfo>) => [...balances.values()].reduce((sum, b) => sum + b.balance, 0n)
  const perRound = ok.map(({ round, ts, balances }) => ({
    round,
    ts,
    cohort: total(balances),
    funded: [...balances.values()].filter((b) => b.balance > 0n).length,
    supply: supply.get(round),
    supplyRead: supply.has(round),
  }))
  // the supply lines only at the rounds it was read at, so they don't break into gaps
  const withSupply = perRound.filter((p) => p.supplyRead)

  // ---- per account: range over the samples
  const rows = accounts.map((account) => {
    const series = ok.map(({ balances }) => balances.get(account.address)!.balance)
    const max = series.reduce((a, b) => (b > a ? b : a), 0n)
    const min = series.reduce((a, b) => (b < a ? b : a), series[0] ?? 0n)
    return { ...account, series, first: series[0] ?? 0n, last: series.at(-1) ?? 0n, min, max }
  })
  const byMax = [...rows].sort((a, b) => (b.max > a.max ? 1 : b.max < a.max ? -1 : 0))

  // ---- exact: every balance change of the top accounts that don't change in every block
  const top = num("top", 4)
  const cap = num("max-versions", 20_000)
  const exactRun = await measure(() =>
    mapLimit(byMax.slice(0, top * 3), 6, async (account) => {
      const points: { round: bigint; ts: number; balance: bigint }[] = []
      for await (const v of algorand.dt.iterateAccountVersions(account.address, {
        exclude: ["all"],
        includeValues: true,
        minRound: rounds[0],
        maxRound: rounds.at(-1),
        limit: 1000,
      })) {
        if (!v.base) continue
        points.push({ round: v.round, ts: v.timestamp, balance: v.base.deleted ? 0n : (v.base.account?.balance.microAlgo ?? 0n) })
        if (points.length >= cap) return { account, points, truncated: true }
      }
      return { account, points, truncated: false }
    }),
  )
  const exact = exactRun.result.filter((e) => !e.truncated).slice(0, top)
  const busy = exactRun.result.filter((e) => e.truncated)
  console.log(
    `exact history of ${exact.length} accounts: ${describe(exactRun)}; ${exact.map((e) => `${e.account.label} ${e.points.length} changes`).join(", ")}` +
      (busy.length ? `; skipped ${busy.map((e) => e.account.label).join(", ")} (over ${cap} changes)` : ""),
  )

  // ---- spot checks against the node's own reads at those rounds
  const checks = await mapLimit(Array.from({ length: 8 }, (_, i) => i), 4, async (i) => {
    const account = byMax[i % Math.min(byMax.length, 20)]
    const sample = ok[Math.floor(((i + 0.5) * ok.length) / 8)]
    const info = await algorand.account.getInformation(account.address, { round: sample.round })
    const ghost = sample.balances.get(account.address)!.balance
    return { account: account.label, round: sample.round, ghost, node: info.balance.microAlgo, match: ghost === info.balance.microAlgo }
  })
  const matches = checks.filter((c) => c.match).length
  console.log(`spot checks against ?round= reads: ${matches}/${checks.length} match`)
  for (const c of checks.filter((c) => !c.match)) console.log(`  ${c.account} at ${c.round}: ghost ${c.ghost}, node ${c.node}`)

  // ---- report
  const shown = byMax.slice(0, 7)
  const sections: Section[] = [
    {
      kind: "line",
      title: `${isGenesis ? "Genesis accounts" : "The accounts"} vs the ALGO supply`,
      subtitle: `Sum of the accounts' balances at ${perRound.length} sampled rounds, beside the ledger's total money and exact online stake at ${withSupply.length === perRound.length ? "the same" : `${withSupply.length} of those`} rounds (\`/v2/ledger/supply?round=\`). Total money leaves out non-participating accounts, such as the genesis reserves, which is why the genesis accounts start above it.`,
      x: "time",
      yLabel: "ALGO",
      zeroY: true,
      series: [
        { label: "Total money", points: withSupply.map((p) => [p.ts, p.supply ? algo(p.supply.totalMoney) : null]), slot: 0 },
        { label: "Online stake", points: withSupply.map((p) => [p.ts, p.supply ? algo(p.supply.onlineStake ?? p.supply.onlineMoney) : null]), slot: 1 },
        { label: isGenesis ? "Genesis accounts" : "Accounts", points: perRound.map((p) => [p.ts, algo(p.cohort)]), slot: 2 },
      ],
    },
    {
      kind: "line",
      title: `Share of the ${algoText(fixedSupply)} ALGO supply held by the ${isGenesis ? "genesis " : ""}accounts`,
      x: "time",
      yLabel: "% of supply",
      zeroY: true,
      series: [
        {
          label: "share",
          points: perRound.map((p) => [p.ts, (Number(p.cohort) / Number(fixedSupply)) * 100]),
          slot: 2,
        },
      ],
    },
    {
      kind: "line",
      title: "Accounts holding any ALGO",
      x: "time",
      yLabel: "accounts",
      zeroY: true,
      series: [{ label: "funded", points: perRound.map((p) => [p.ts, p.funded]), slot: 0 }],
    },
    {
      kind: "line",
      title: "Largest accounts, sampled",
      subtitle: `The ${shown.length} accounts with the highest balance at any sample, and the rest together.`,
      x: "time",
      yLabel: "ALGO",
      zeroY: true,
      stacked: true,
      series: [
        ...shown.map((r, i): LineSeries => ({ label: r.label, points: ok.map(({ ts }, j) => [ts, algo(r.series[j])]), slot: i })),
        {
          label: "Others",
          points: ok.map(({ ts, balances }, j) => [ts, algo(total(balances) - shown.reduce((sum, r) => sum + r.series[j], 0n))]),
          slot: 7,
        },
      ],
    },
    {
      kind: "line",
      title: "Exact balance history vs samples",
      subtitle:
        "Lines: every change, from `/v2/accounts/{addr}/versions` (each version as the account read at that round, pending rewards included). Dots: the sampled ghost reads.",
      x: "time",
      yLabel: "ALGO",
      series: exact.flatMap(({ account, points }, i): LineSeries[] => {
        const row = rows.find((r) => r.address === account.address)!
        return [
          { label: `${account.label} (exact)`, points: points.map((p) => [p.ts, algo(p.balance)]), step: true, slot: i },
          { label: `${account.label} (sampled)`, points: ok.map(({ ts }, j) => [ts, algo(row.series[j])]), dots: true, slot: i },
        ]
      }),
    },
    {
      kind: "table",
      title: "Every account",
      subtitle: "Sorted by the highest balance at any sample. ALGO.",
      csv: "accounts",
      columns: ["account", "label", ...(isGenesis ? ["at genesis"] : []), `at ${ok[0]?.round}`, `at ${ok.at(-1)?.round}`, "min", "max"],
      rows: byMax.map((r) => [
        `\`${r.address}\``,
        r.label,
        ...(isGenesis ? [algoText(r.genesis ?? 0n)] : []),
        algoText(r.first),
        algoText(r.last),
        algoText(r.min),
        algoText(r.max),
      ]),
    },
    {
      kind: "table",
      title: "Protocol overrides",
      subtitle:
        "The reader contract is AVM 11, which MainNet only allows from round ~46.5M. Older rounds run under the latest protocol, as if it took effect right after the round; the node notes where the result rests on data the round never produced.",
      columns: ["protocol", "rounds", "first", "last", "notes"],
      rows: [...overrides].map(([key, o]) => [key, o.rounds, String(o.first), String(o.last), [...o.notes].join(", ")]),
    },
    {
      kind: "table",
      title: "Spot checks",
      subtitle: "Sampled ghost reads against the node's own `GET /v2/accounts/{addr}?round=`, in microAlgo.",
      columns: ["account", "round", "ghost read", "?round= read", "match"],
      rows: checks.map((c) => [c.account, String(c.round), c.ghost, c.node, c.match ? "yes" : "NO"]),
    },
    {
      kind: "text",
      title: "How it was read",
      paragraphs: [
        nodeLine + ".",
        `Sampled balances: ${addresses.length} accounts × ${rounds.length} rounds in ${describe(sampled)}, through \`sdk.getBalanceInfoAtRounds(accounts, rounds)\`` +
          (parts.length > 1 ? `, the rounds dealt into ${parts.length} parts of ${perRequest} (every ${parts.length}th round, so each spans the whole range) sent in parallel` : "") +
          `. Block timestamps for the same rounds: ${describe(times)}.`,
        `Exact histories: ${describe(exactRun)} (\`algorand.dt.iterateAccountVersions(addr, { exclude: ['all'], includeValues: true })\`). Supply: ${describe(supplyRun)}.`,
      ],
    },
  ]
  const path = writeReport("balances-over-time", {
    title: isGenesis ? "Genesis accounts over time" : "Balances over time",
    subtitle: `${accounts.length} accounts at ${perRound.length} rounds from ${ok[0]?.round} to ${ok.at(-1)?.round}, read from a dtalgorand node.`,
    stats: [
      { label: "Accounts", value: accounts.length.toLocaleString("en-US") },
      { label: "Rounds sampled", value: perRound.length.toLocaleString("en-US"), note: `${rounds[0]} → ${rounds.at(-1)}` },
      { label: "Balances read", value: (accounts.length * perRound.length).toLocaleString("en-US"), note: `${sampled.simulates} simulate requests` },
      { label: "Wall time", value: `${(sampled.ms / 1000).toFixed(1)} s`, note: "sampled balances" },
      { label: "Simulate time", value: `${(sampled.simulateMs / 1000).toFixed(1)} s`, note: `requests in flight; client ${(sampled.clientMs / 1000).toFixed(1)} s` },
      { label: "Spot checks", value: `${matches}/${checks.length}`, note: "match `?round=` reads" },
    ],
    sections,
    data: { perRound, accounts: rows.map(({ series, ...r }) => r) },
  })
  console.log(`report: ${path}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
