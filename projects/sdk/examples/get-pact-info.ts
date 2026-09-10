import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK, PactInfo, PactPoolType } from "../src/index.js"

const algorand = AlgorandClient.mainNet()

// no ghostAppId: the deployed app predates this method, so run the deployment-free ghost path
const sdk = new AbelGhostSDK({
  algorand,
  concurrency: 10,
  debug: true,
})

// PACT's own API, used ONLY as an oracle to check what the contract worked out from algod alone.
const PACT_API = "https://api.pact.fi/api/pools?limit=100&offset=0"

type ApiPool = {
  on_chain_id: string
  pool_type: string
  fee_bps: number
  primary_asset: { id: string; unit_name: string }
  secondary_asset: { id: string; unit_name: string }
}

type Expected = {
  type: PactPoolType
  asset1Id: bigint
  asset1UnitName: string
  asset2Id: bigint
  asset2UnitName: string
  feeBps: bigint
}

// the API reports pool_type in its own short form
const API_POOL_TYPES: Record<string, PactPoolType> = { CONST: "CONSTANT_PRODUCT", STBL: "STABLESWAP" }

const REFUSED: Expected = { type: "", asset1Id: 0n, asset1UnitName: "", asset2Id: 0n, asset2UnitName: "", feeBps: 0n }

// cases the API listing does not cover: managed weighted pools, and everything that has to be
// refused. ids and expectations from PACT_ID.md
const FIXTURES: Record<string, Expected> = {
  3661371688: { type: "MANAGED_WEIGHTED", asset1Id: 0n, asset1UnitName: "ALGO", asset2Id: 2994233666n, asset2UnitName: "POW", feeBps: 36n },
  3700138545: { type: "MANAGED_WEIGHTED", asset1Id: 2614577662n, asset1UnitName: "ATARD", asset2Id: 3121962516n, asset2UnitName: "CORN", feeBps: 36n },
  1072843805: REFUSED, // constant product factory -- PACT creator, but not pool-shaped
  3656084442: REFUSED, // managed weighted factory
  3656084807: REFUSED, // managed weighted vault
  612810738: REFUSED, // legacy pool, arbitrary creator
  620990689: REFUSED, // legacy pool
  621150092: REFUSED, // legacy pool
  31566704: REFUSED, // an ASA id: no such application
  999999999999: REFUSED, // never existed
  0: REFUSED, // app id 0 means "the currently executing app" to the AVM
}

function describe(info: PactInfo | Expected): string {
  return (
    `${(info.type || "-").padEnd(16)} ` +
    `${info.asset1UnitName}(${info.asset1Id})-${info.asset2UnitName}(${info.asset2Id}) ${info.feeBps}bps`
  )
}

function same(got: PactInfo, want: Expected): boolean {
  return (
    got.type === want.type &&
    got.asset1Id === want.asset1Id &&
    got.asset1UnitName === want.asset1UnitName &&
    got.asset2Id === want.asset2Id &&
    got.asset2UnitName === want.asset2UnitName &&
    got.feeBps === want.feeBps
  )
}

;(async () => {
  const argIds = process.argv.slice(2)

  if (argIds.length > 0) {
    const data = await sdk.getPactInfo(argIds.map(BigInt))
    for (const [appId, info] of data) console.log(`${appId}\t${describe(info)}`)
    return
  }

  // no args: check the contract against PACT's API for real pools, and against the PACT_ID.md
  // fixtures for managed weighted pools and for everything that must be refused
  const res = await fetch(PACT_API)
  if (!res.ok) throw new Error(`pact api request failed: ${res.status} ${res.statusText}`)
  const { results } = (await res.json()) as { results: ApiPool[] }
  console.log(`Fetched ${results.length} pools from the PACT API`)

  const expected = new Map<bigint, Expected>()
  for (const pool of results) {
    expected.set(BigInt(pool.on_chain_id), {
      type: API_POOL_TYPES[pool.pool_type] ?? "",
      asset1Id: BigInt(pool.primary_asset.id),
      asset1UnitName: pool.primary_asset.unit_name,
      asset2Id: BigInt(pool.secondary_asset.id),
      asset2UnitName: pool.secondary_asset.unit_name,
      feeBps: BigInt(pool.fee_bps),
    })
  }
  for (const [appId, want] of Object.entries(FIXTURES)) expected.set(BigInt(appId), want)

  const appIds = [...expected.keys()]
  console.time("fetch")
  const data = await sdk.getPactInfo(appIds)
  console.timeEnd("fetch")

  let mismatches = 0
  for (const [appId, info] of data) {
    const want = expected.get(appId)!
    const ok = same(info, want)
    if (!ok) mismatches++
    console.log(`${ok ? "ok  " : "BAD "} ${String(appId).padEnd(13)} ${describe(info)}${ok ? "" : `\n     wanted ${describe(want)}`}`)
  }

  const values = [...data.values()]
  console.log({
    total: data.size,
    pools: values.filter((i) => i.type !== "").length,
    refused: values.filter((i) => i.type === "").length,
    byType: values.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.type || "-"]: (acc[i.type || "-"] ?? 0) + 1 }), {}),
    mismatches,
  })

  if (mismatches > 0) {
    console.error(`MISMATCH: ${mismatches} pool(s) did not match PACT's own numbers`)
    process.exit(1)
  }
})()
