// When was each account rekeyed, and to what? Found two ways on a dtalgorand node, and checked against each other.
//
//   pnpm rekeys [addr … | --file addrs.txt | --recent 2000] [--check 60] [--max-versions 20000]
//
// - Search: the reader contract reads every account's auth address at 256 rounds from genesis to now, in one
//   `atRounds` call. Wherever two samples differ, it reads 256 rounds between them, and so on down to the block: about
//   four levels from genesis.
// - Exact: an account's `/versions` lists every change to its base record, so every rekey, including one that was
//   undone between two samples, which the search can't see.
// Accounts default to the senders of the latest blocks.
import { readFileSync } from "node:fs"
import { cached } from "./lib/cache.js"
import { algorand, args, describe, makeSDK, mapLimit, measure, num, printNode, safeTip, short, spread, str } from "./lib/node.js"
import { writeReport, type Section } from "./lib/report.js"

interface Rekey {
  account: string
  round: bigint
  from?: string
  to?: string
}

/** senders of the latest blocks, up to `count` */
async function recentSenders(tip: bigint, count: number): Promise<string[]> {
  return cached(`recent-senders-${count}`, async () => {
    const senders = new Set<string>()
    for (let r = tip; senders.size < count && r > tip - 20_000n; r -= 100n) {
      const blocks = await mapLimit(Array.from({ length: 100 }, (_, i) => r - BigInt(i)), 16, (round) =>
        algorand.client.algod.block(round).do().catch(() => undefined),
      )
      if (blocks.every((b) => !b)) break
      for (const block of blocks) for (const { signedTxn } of block?.block.payset ?? []) senders.add(signedTxn.signedTxn.txn.sender.toString())
      process.stdout.write(`\r  senders of the latest blocks: ${senders.size}`)
    }
    process.stdout.write("\n")
    return [...senders].slice(0, count)
  })
}

;(async () => {
  const sdk = makeSDK({ registry: false })
  const [nodeLine, tip] = await Promise.all([printNode(sdk), safeTip()])
  const file = str("file")
  const accounts = file
    ? readFileSync(file, "utf8").split(/\s+/).filter(Boolean)
    : args.positional.length
      ? args.positional
      : await recentSenders(tip, num("recent", 2000))
  console.log(`${accounts.length} accounts, rounds 1 to ${tip}`)

  // ---- search: sample everyone, then narrow every change down to its block
  let searchRequests = 0
  const rekeys: Rekey[] = []
  const levels: { level: number; intervals: number; ms: number; simulates: number }[] = []
  const top = spread(1n, tip, 256)
  const first = await measure(() => sdk.getAuthAddrsAtRounds(accounts, top))
  searchRequests += first.simulates
  const value = (r: (typeof first.result)[number], account: string) => {
    if (!r.ok) throw r.error
    return r.value.get(account)
  }
  // intervals (a, b] in which an account's auth address changed
  let intervals: { account: string; a: bigint; b: bigint; from?: string; to?: string }[] = []
  for (const account of accounts)
    for (let i = 1; i < top.length; i++) {
      const from = value(first.result[i - 1], account)
      const to = value(first.result[i], account)
      if (from !== to) intervals.push({ account, a: top[i - 1], b: top[i], from, to })
    }
  levels.push({ level: 0, intervals: intervals.length, ms: first.ms, simulates: first.simulates })
  console.log(`level 0: ${accounts.length} accounts × ${top.length} rounds in ${describe(first)}; ${intervals.length} changes to narrow down`)

  for (let level = 1; intervals.length; level++) {
    const done = intervals.filter((i) => i.b - i.a === 1n)
    for (const { account, b, from, to } of done) rekeys.push({ account, round: b, from, to })
    const open = intervals.filter((i) => i.b - i.a > 1n)
    if (!open.length) break
    const step = await measure(() =>
      mapLimit(open, 8, async (interval) => {
        const rounds = spread(interval.a + 1n, interval.b, Math.min(256, Number(interval.b - interval.a)))
        const reads = await sdk.getAuthAddrsAtRounds([interval.account], rounds)
        const found: typeof intervals = []
        let prevRound = interval.a
        let prev = interval.from
        rounds.forEach((round, i) => {
          const current = value(reads[i], interval.account)
          if (current !== prev) found.push({ account: interval.account, a: prevRound, b: round, from: prev, to: current })
          prevRound = round
          prev = current
        })
        return found
      }),
    )
    searchRequests += step.simulates
    intervals = step.result.flat()
    levels.push({ level, intervals: open.length, ms: step.ms, simulates: step.simulates })
    console.log(`level ${level}: ${open.length} intervals in ${describe(step)}`)
  }
  rekeys.sort((x, y) => (x.round < y.round ? -1 : 1))
  const rekeyed = new Set(rekeys.map((r) => r.account))
  console.log(`search: ${rekeys.length} auth address changes in ${rekeyed.size} accounts, ${searchRequests} simulate requests`)

  // ---- exact: the base record history of a sample of accounts
  const sample = [...[...rekeyed].slice(0, num("check", 60) / 2), ...accounts.filter((a) => !rekeyed.has(a)).slice(0, num("check", 60) / 2)]
  const cap = num("max-versions", 20_000)
  const exact = await measure(() =>
    mapLimit(sample, 8, async (account) => {
      const changes: Rekey[] = []
      let prev: string | undefined
      let versions = 0
      for await (const v of algorand.dt.iterateAccountVersions(account, { exclude: ["all"], includeValues: true, limit: 1000 })) {
        if (!v.base) continue
        if (++versions > cap) return { account, changes, truncated: true }
        const auth = v.base.deleted ? undefined : v.base.account?.authAddr?.toString()
        if (auth !== prev) changes.push({ account, round: v.round, from: prev, to: auth })
        prev = auth
      }
      return { account, changes, truncated: false }
    }),
  )
  const checked = exact.result.filter((e) => !e.truncated)
  let agree = 0
  const missed: Rekey[] = []
  const extra: Rekey[] = []
  for (const { account, changes } of checked) {
    const found = rekeys.filter((r) => r.account === account)
    const key = (r: Rekey) => `${r.round}:${r.to ?? ""}`
    const foundKeys = new Set(found.map(key))
    const exactKeys = new Set(changes.map(key))
    const accountMissed = changes.filter((c) => !foundKeys.has(key(c)))
    const accountExtra = found.filter((f) => !exactKeys.has(key(f)))
    missed.push(...accountMissed)
    extra.push(...accountExtra)
    if (!accountMissed.length && !accountExtra.length) agree++
  }
  console.log(
    `exact check of ${checked.length} accounts (${describe(exact)}): ${agree} agree; ${missed.length} changes the search missed, ${extra.length} it found that the history doesn't have` +
      (exact.result.length > checked.length ? `; ${exact.result.length - checked.length} skipped (over ${cap} changes)` : ""),
  )

  // ---- report
  const times = await sdk.getBlockTimesAndTcAtRounds(rekeys.map((r) => r.round), 1)
  const timeOf = new Map(times.flatMap((t) => (t.ok ? [[t.round, t.value[0].ts] as const] : [])))
  const byQuarter = new Map<string, number>()
  for (const r of rekeys) {
    const date = new Date((timeOf.get(r.round) ?? 0) * 1000)
    const quarter = `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}`
    byQuarter.set(quarter, (byQuarter.get(quarter) ?? 0) + 1)
  }
  const quarters = [...byQuarter.keys()].sort()
  const sections: Section[] = [
    {
      kind: "bar",
      title: "Auth address changes per quarter",
      subtitle: `Every rekey (and rekey back) of the ${accounts.length.toLocaleString("en-US")} accounts the search found, by the quarter of its block.`,
      labels: quarters,
      yLabel: "changes",
      series: [{ label: "changes", values: quarters.map((q) => byQuarter.get(q)!), slot: 0 }],
    },
    {
      kind: "table",
      title: "How the search narrowed down",
      subtitle: "Level 0 reads every account at 256 rounds; each level after reads 256 rounds inside each interval where two samples differed.",
      columns: ["level", "accounts or intervals", "simulate requests", "wall time (ms)"],
      rows: levels.map((l) => [l.level, l.level === 0 ? `${accounts.length} accounts` : `${l.intervals} intervals`, l.simulates, l.ms]),
    },
    {
      kind: "table",
      title: "Search vs exact history",
      subtitle:
        "For a sample of accounts, half of them rekeyed: the changes the search found against every change in `/v2/accounts/{addr}/versions`. The search misses a rekey that was undone between two of its level-0 samples.",
      columns: ["", "count"],
      rows: [
        ["accounts checked", checked.length],
        ["accounts where both agree", agree],
        ["changes only in the history (missed by the search)", missed.length],
        ["changes only in the search", extra.length],
        ["simulate requests, search (all accounts)", searchRequests],
        ["/versions requests, exact (sample only)", exact.versions],
      ],
    },
    {
      kind: "table",
      title: "Every auth address change found",
      csv: "rekeys",
      columns: ["date (UTC)", "round", "account", "from", "to"],
      rows: rekeys.map((r) => [
        new Date((timeOf.get(r.round) ?? 0) * 1000).toISOString().slice(0, 16).replace("T", " "),
        String(r.round),
        `\`${r.account}\``,
        r.from ? short(r.from) : "(none)",
        r.to ? short(r.to) : "(none)",
      ]),
    },
    ...(missed.length
      ? [
          {
            kind: "table" as const,
            title: "Changes the search missed",
            columns: ["round", "account", "from", "to"],
            rows: missed.map((r) => [String(r.round), `\`${r.account}\``, r.from ? short(r.from) : "(none)", r.to ? short(r.to) : "(none)"]),
          },
        ]
      : []),
    {
      kind: "text",
      title: "How it was read",
      paragraphs: [
        nodeLine + ".",
        `Search: \`sdk.getAuthAddrsAtRounds(accounts, rounds)\`, ${searchRequests} simulate requests in all. Exact: \`algorand.dt.iterateAccountVersions(addr, { exclude: ['all'], includeValues: true })\`, ${describe(exact)}.`,
      ],
    },
  ]
  const path = writeReport("rekey-forensics", {
    title: "Rekey forensics",
    subtitle: `When ${accounts.length.toLocaleString("en-US")} accounts changed their auth address, from genesis to round ${tip}, read from a dtalgorand node.`,
    stats: [
      { label: "Accounts", value: accounts.length.toLocaleString("en-US") },
      { label: "Rekeyed at some point", value: rekeyed.size.toLocaleString("en-US"), note: `${rekeys.length} changes` },
      { label: "Search", value: `${searchRequests} requests`, note: `level 0: ${(first.ms / 1000).toFixed(1)} s for ${(accounts.length * top.length).toLocaleString("en-US")} reads` },
      { label: "Exact check", value: `${agree}/${checked.length}`, note: "accounts agree" },
    ],
    sections,
    data: { rekeys, levels, missed, extra },
  })
  console.log(`report: ${path}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
