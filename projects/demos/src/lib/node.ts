// Shared setup for the demos: the dtalgorand node, the SDK, request counting and timing, and argument parsing.
//
//   DT_ALGOD_SERVER  the dtalgorand node, with its port if not the protocol's own. Default https://mainnet-api-dt.d13.co
//   DT_ALGOD_TOKEN   its API token. Default none
//   INDEXER_SERVER   an indexer, for the lists algod can't give (Tinyman pool escrows). Default nodely's MainNet indexer
//   REQUEST_LOG=1    log every query and /versions request as it finishes
//
// The demos read only through the node's read-only queries (POST /v2/query), and stop if the node is stock algod or has
// queries off. A simulate request is a bug (ghostkit's query backend never simulates), so a demo that sends one stops.
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK, MAINNET_ABEL_REGISTRY_APP_ID, type GhostkitNode } from "abel-ghost-sdk/src/index.js"

const server = new URL(process.env.DT_ALGOD_SERVER ?? "https://mainnet-api-dt.d13.co")

export const algorand = AlgorandClient.fromConfig({
  algodConfig: {
    server: `${server.protocol}//${server.hostname}`,
    port: server.port || (server.protocol === "https:" ? 443 : 80),
    token: process.env.DT_ALGOD_TOKEN ?? "",
  },
})

export const INDEXER_SERVER = process.env.INDEXER_SERVER ?? "https://mainnet-idx.4160.nodely.dev"

/** command-line flags (`--name value` or `--flag`) and the positional arguments */
export function parseArgs(argv = process.argv.slice(2)): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) flags.set(arg.slice(2), argv[++i])
      else flags.set(arg.slice(2), true)
    } else positional.push(arg)
  }
  return { flags, positional }
}

export const args = parseArgs()
export const flag = (name: string) => args.flags.has(name)
export const num = (name: string, fallback: number) => (typeof args.flags.get(name) === "string" ? Number(args.flags.get(name)) : fallback)
export const str = (name: string, fallback?: string) => (typeof args.flags.get(name) === "string" ? (args.flags.get(name) as string) : fallback)

/** the SDK on the node, reading through its read-only queries only */
export function makeSDK(options: { registry?: boolean } = {}): AbelGhostSDK {
  return new AbelGhostSDK({
    algorand,
    backend: "query",
    registryAppId: options.registry === false ? undefined : MAINNET_ABEL_REGISTRY_APP_ID,
  })
}

/** the node's query limits; printNode has already stopped the demo if it has none */
export async function queryLimits(sdk: AbelGhostSDK): Promise<NonNullable<Extract<GhostkitNode, { kind: "dt" }>["query"]>> {
  const node = await sdk.getNode()
  if (node.kind !== "dt" || !node.query) throw new Error(`${server.host} has no read-only queries`)
  return node.query
}

// ---- request counting, by wrapping fetch, which algosdk's default HTTP client uses

type Kind = "simulate" | "query" | "versions" | "other"
const counts: Record<Kind, number> = { simulate: 0, query: 0, versions: 0, other: 0 }
const queryMs: number[] = []
/** when each request was in flight: from the call to the response (a query's to the end of its body) */
const spans: { kind: Kind; start: number; end: number }[] = []
const LOG = process.env.REQUEST_LOG === "1"
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const path = new URL(url).pathname
  const kind: Kind =
    path === "/v2/transactions/simulate" ? "simulate" : path === "/v2/query" ? "query" : path.includes("/versions") ? "versions" : "other"
  counts[kind]++
  if (kind === "simulate") {
    // the query backend never simulates: a simulate here means a read went around queries
    console.error(`unexpected simulate request (${path}): the demos read only through queries`)
    console.error(new Error("simulate request").stack)
    process.exit(1)
  }
  const start = performance.now()
  try {
    const response = await realFetch(input, init)
    if (kind !== "query") {
      if (LOG && kind === "versions") console.log(`    ${kind}: ${(performance.now() - start).toFixed(0)} ms ${response.status}`)
      return response
    }
    // read the whole body, so the time covers the full response
    const body = await response.arrayBuffer()
    const ms = performance.now() - start
    queryMs.push(ms)
    if (LOG) console.log(`    ${kind}: ${ms.toFixed(0)} ms, ${response.status}, ${(body.byteLength / 1024).toFixed(1)} KiB`)
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally {
    spans.push({ kind, start, end: performance.now() })
  }
}) as typeof fetch

/** how long at least one of `spans` was in flight between `from` and `to` */
function inFlight(of: { start: number; end: number }[], from: number, to: number): number {
  const clipped = of
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  let total = 0
  let reach = from
  for (const s of clipped) {
    if (s.end <= reach) continue
    total += s.end - Math.max(s.start, reach)
    reach = s.end
  }
  return total
}

export interface Measured<T> {
  result: T
  /** wall time */
  ms: number
  /** time with at least one query request in flight, to the end of its body */
  queryMs: number
  /** time with other requests, and no query, in flight */
  otherRequestMs: number
  /** time with no request in flight: decoding responses and the demo's own work */
  clientMs: number
  queries: number
  versions: number
  other: number
  /** median time of one query request */
  queryMedianMs: number
}

/** runs `f`, with its wall time, how much of it went to requests, and the requests it made */
export async function measure<T>(f: () => Promise<T>): Promise<Measured<T>> {
  const before = { ...counts }
  const firstTiming = queryMs.length
  const start = performance.now()
  const result = await f()
  const end = performance.now()
  const ms = Math.round(end - start)
  const times = queryMs.slice(firstTiming).sort((a, b) => a - b)
  const querying = inFlight(spans.filter((s) => s.kind === "query"), start, end)
  const requesting = inFlight(spans, start, end)
  return {
    result,
    ms,
    queryMs: Math.round(querying),
    otherRequestMs: Math.round(requesting - querying),
    clientMs: Math.round(end - start - requesting),
    queries: counts.query - before.query,
    versions: counts.versions - before.versions,
    other: counts.other - before.other,
    queryMedianMs: Math.round(times[Math.floor(times.length / 2)] ?? 0),
  }
}

export const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)

/** "1, 2 or 5 queries" */
export const queries = (n: number) => `${n.toLocaleString("en-US")} quer${n === 1 ? "y" : "ies"}`

/** "1.2 s (query 700 ms, other requests 80 ms, client 420 ms), 3 queries (median 400 ms), 12 /versions, 2 other" */
export function describe(m: Measured<unknown>): string {
  const split = [
    m.queries ? `query ${duration(m.queryMs)}` : "",
    m.versions || m.other ? `other requests ${duration(m.otherRequestMs)}` : "",
    m.queries || m.versions || m.other ? `client ${duration(m.clientMs)}` : "",
  ].filter(Boolean)
  const parts = [duration(m.ms) + (split.length ? ` (${split.join(", ")})` : "")]
  if (m.queries) parts.push(`${queries(m.queries)} (median ${m.queryMedianMs} ms)`)
  if (m.versions) parts.push(`${m.versions} /versions`)
  if (m.other) parts.push(`${m.other} other`)
  return parts.join(", ")
}

/** the node's latest round, less a few rounds that may still be on their way to disk */
export async function safeTip(): Promise<bigint> {
  const { lastRound } = await algorand.client.algod.status().do()
  return lastRound - 10n
}

/** prints the node's query limits, and exits if the node can't be queried */
export async function printNode(sdk: AbelGhostSDK): Promise<string> {
  let node
  try {
    // throws for the query backend on stock algod, on a node with queries off, or without the forks
    await sdk.getBackend()
    node = await sdk.getNode()
  } catch (e) {
    console.error(`${server.host}: ${(e as Error).message}`)
    console.error("The demos read only through read-only queries: they need a dtalgorand node with queries on (GET /v2/capabilities reports `query`) and the dtalgorand forks")
    process.exit(1)
  }
  if (node.kind !== "dt" || !node.query) {
    console.error(`${server.host}: ${node.kind === "dt" ? "the node has queries off" : node.reason}`)
    process.exit(1)
  }
  const q = node.query
  const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`
  const line =
    `dtalgorand node ${server.host}, read through queries: up to ${q.maxCalls.toLocaleString("en-US")} calls and ${q.maxRounds} rounds per request, ` +
    `${q.maxCallBudget.toLocaleString("en-US")} opcode budget, ${(q.maxCallLogBytes / 1024).toFixed(0)} KiB of logs and ${q.maxCallStateBytes ? mb(q.maxCallStateBytes) : "any amount"} of ledger state per call, ` +
    `${mb(q.maxResponseBytes)} per response; time travel ${node.limits.timeTravel ? "on" : "off"}`
  console.log(line)
  return line
}

/** maps with at most `limit` promises pending at once */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** `count` rounds evenly from `from` to `to`, both included */
export function spread(from: bigint, to: bigint, count: number): bigint[] {
  if (count <= 1 || to <= from) return [to]
  const span = to - from
  return [...new Set(Array.from({ length: count }, (_, i) => from + (span * BigInt(i)) / BigInt(count - 1)))]
}

/** exact ALGO from microAlgo, as a float for charts */
export const algo = (microAlgo: bigint) => Number(microAlgo) / 1e6

/** ALGO with thousands separators */
export const algoText = (microAlgo: bigint, digits = 0) =>
  (Number(microAlgo) / 1e6).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export interface Supply {
  round: bigint
  totalMoney: bigint
  onlineMoney: bigint
  /** dtalgorand only: the exact online stake, without keys that expired */
  onlineStake?: bigint
}

/** `GET /v2/ledger/supply?round=`, raw, for the dtalgorand-only `online-stake`; undefined on a 404 (no record) */
export async function supplyAt(round: bigint): Promise<Supply | undefined> {
  const response = await fetch(`${server.origin}/v2/ledger/supply?round=${round}`, {
    headers: process.env.DT_ALGOD_TOKEN ? { "X-Algo-API-Token": process.env.DT_ALGOD_TOKEN } : {},
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`supply at ${round}: ${response.status} ${await response.text()}`)
  // big numbers: parse the integers as bigint
  const text = await response.text()
  const field = (name: string) => {
    const match = text.match(new RegExp(`"${name}":(\\d+)`))
    return match ? BigInt(match[1]) : undefined
  }
  return { round, totalMoney: field("total-money")!, onlineMoney: field("online-money")!, onlineStake: field("online-stake") }
}

/**
 * The supply at up to `--supply-samples` (default 256) of `rounds`, evenly picked, a few requests at a time. It takes one
 * request per round, so reading it at every one of thousands of sampled rounds would flood the node. Rounds not read are
 * missing from the map; rounds without a record map to undefined.
 */
export async function suppliesAt(rounds: bigint[]): Promise<Map<bigint, Supply | undefined>> {
  const max = Math.max(1, num("supply-samples", 256))
  const picked = rounds.length <= max ? rounds : [...new Set(Array.from({ length: max }, (_, i) => rounds[Math.round((i * (rounds.length - 1)) / (max - 1 || 1))]))]
  const supplies = await mapLimit(picked, 8, supplyAt)
  return new Map(picked.map((round, i) => [round, supplies[i]]))
}
