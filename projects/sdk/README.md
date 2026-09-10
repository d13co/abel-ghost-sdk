# Abel Ghost SDK

Tiny [Ghostkit](https://github.com/d13co/ghostkit) SDK for [Abel](https://github.com/Algorand-Developer-Retreat/abel). It batches read-only on-chain lookups (balances, asset metadata, block times, auth/rekey addresses) into single `simulate` calls — **no deployment, no fees, on any network**.

For background on _how_ the ghost (simulate-based, deployment-free) calls work, and the canonical build process (`algokit project run build` from the repo root), see the [root README](../../README.md).

## Install

```bash
npm install abel-ghost-sdk
# peer deps
npm install @algorandfoundation/algokit-utils algosdk
```

## Quick start

```ts
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK } from "abel-ghost-sdk"

const algorand = AlgorandClient.mainNet()
const sdk = new AbelGhostSDK({ algorand })

// Batch look up asset metadata (one simulate round-trip)
const assets = await sdk.getAssetsTinyLabels([31566704n])
console.log(assets.get(31566704n))
// { id: 31566704n, name: 'USDC', unitName: 'USDC', decimals: 6, labels: [...] }
```

## Constructor

```ts
new AbelGhostSDK({
  algorand,            // AlgorandClient (required) — picks the network (LocalNet/TestNet/MainNet)
  registryAppId,       // number | bigint — Abel label registry app id (MainNet: 2914159523). Needed for label methods.
  concurrency = 4,     // how many chunked simulate calls run in parallel
  ghostAppId,          // bigint — optional deployed ghost app id. Omit to use the deployment-free ghost path.
  readerAccount,       // string — sender used for simulation. Defaults to a fee-sink address; override per network if needed.
  cacheParamsTimeout,  // number — ms to cache algod suggested params across chunked calls. Defaults to 75; 0 disables caching.
})
```

Requests larger than the per-call limit (63 accounts / assets) are chunked automatically and run with the configured `concurrency`.

## Methods

### `getBalanceInfo(accounts: string[]): Promise<Map<string, BalanceInfo>>`

Algo balance and minimum balance for many accounts. `BalanceInfo` is `{ balance: bigint, minBalance: bigint }`; missing/empty accounts come back as `{ balance: 0n, minBalance: 0n }`.

```ts
const balances = await sdk.getBalanceInfo([
  "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE",
])
for (const [addr, { balance, minBalance }] of balances) {
  console.log(addr, balance, minBalance)
}
```

### `getAuthAddrs(accounts: string[]): Promise<Map<string, string | undefined>>`

Auth (rekey) address for many accounts. Returns the rekeyed-to address, or `undefined` when an account is not rekeyed.

```ts
const authAddrs = await sdk.getAuthAddrs([
  "AAEXOSW7JKN4IYPMUSKKIIJXIK2RRXMBWVZTN2RH5DDH4HZSQETPYBHCJQ",
])
authAddrs.get("AAEXOSW7JKN4IYPMUSKKIIJXIK2RRXMBWVZTN2RH5DDH4HZSQETPYBHCJQ")
// "XSKED5VKZZCSYNDWXZJI65JM2HP7HZFJWCOBIMOONKHTK5UVKENBNVDEYM"
```

### `getAssetsTinyLabels(assetIds: (number | bigint)[]): Promise<Map<bigint, AssetTinyLabels>>`

Lightweight metadata for many assets in one go. `AssetTinyLabels` is `{ id: bigint, name: string, unitName: string, decimals: number, labels: string[] }`. The `labels` array is populated from the Abel registry when `registryAppId` is set. The `"pv"` label means **Pera Verified**.

```ts
const sdk = new AbelGhostSDK({ algorand, registryAppId: 2914159523 })
const assets = await sdk.getAssetsTinyLabels([31566704, 312769])
console.log(assets.get(31566704n))
```

### `getAssetLabels(assetId: number | bigint): Promise<string[]>`

Abel registry labels for a single asset. Returns `[]` if no `registryAppId` is configured.

```ts
const labels = await sdk.getAssetLabels(31566704)
```

### `getAllAssetIDs(): Promise<bigint[]>`

Every asset id known to the configured Abel registry (reads the registry's box names). Returns `[]` without a `registryAppId`.

```ts
const ids = await sdk.getAllAssetIDs()
```

### `getBlockTimesAndTc(firstRound, lastRound): Promise<BlockRoundTimeAndTc[]>`

Timestamp and transaction counter for a range of blocks. Each entry is `{ rnd: bigint, ts: number, tc: bigint }`.

```ts
const { lastRound } = await algorand.client.algod.status().do()
const blocks = await sdk.getBlockTimesAndTc(lastRound - 1000n, lastRound)
console.log(blocks[0]) // { rnd, ts, tc }
```

### `getTinymanInfo(lpEscrows: string[], tinymanAppId?: number | bigint): Promise<Map<string, TinymanInfo>>`

Tinyman pool info for many pool (LP) escrow accounts. `TinymanInfo` is `{ validRekey: boolean, asset1Id: bigint, asset1UnitName: string, asset2Id: bigint, asset2UnitName: string }`.

`validRekey` is `true` when the escrow is rekeyed to the Tinyman app account, which is what makes it a genuine pool escrow rather than a lookalike. The asset ids and unit names are read from the escrow's local state on the Tinyman app. `tinymanAppId` defaults to `MAINNET_TINYMAN_V2_APP_ID` (`1002541853`).

Addresses that are not pool escrows — unfunded, not opted into the app, or plain accounts — come back as all-zero rather than failing the batch. A genuine pool always has a non-zero `asset1Id`, since Tinyman orders pairs so ALGO (asset id 0) is always asset 2; ALGO is reported with the unit name `"ALGO"`, and an asset that has since been deleted keeps its id but has an empty unit name.

```ts
const pools = await sdk.getTinymanInfo([
  "4PE4NCV73L26GIUKZPZTIEASAERJQL2E4IFVXPTOPWVQFZ2RHCQW3VU7AM",
])
pools.get("4PE4NCV73L26GIUKZPZTIEASAERJQL2E4IFVXPTOPWVQFZ2RHCQW3VU7AM")
// { validRekey: true, asset1Id: 1065092715n, asset1UnitName: "COSG", asset2Id: 0n, asset2UnitName: "ALGO" }
```

Batched 42 escrows per simulate: each escrow can cost 3 of the group's 128 resource references (the account plus its two assets), on top of one reference for the Tinyman app itself.

### `getPactInfo(pactAppIds: (number | bigint)[], creators?: PactPoolCreators): Promise<Map<bigint, PactInfo>>`

PACT pool info for many pool app ids, keyed by app id. `PactInfo` is `{ type: PactPoolType | "", asset1Id: bigint, asset1UnitName: string, asset2Id: bigint, asset2UnitName: string, feeBps: bigint }`, where `PactPoolType` is `"CONSTANT_PRODUCT" | "STABLESWAP" | "MANAGED_WEIGHTED"`.

Each app is authenticated from algod alone, no PACT API: its global-state *shape* picks the pool type, and that type's PACT creator — stamped by consensus at app creation, so unforgeable — has to match. Constant-product and stableswap pools carry the pair and fee packed into `CONFIG` (cross-checked against `FEE_BPS`); managed weighted pools carry them in `asset_a` / `asset_b` / `swap_fee_bps`.

`creators` are the expected pool creators, one per type: `{ CONSTANT_PRODUCT, STABLESWAP, MANAGED_WEIGHTED }`, each a base32 address. It defaults to `MAINNET_PACT_POOL_CREATORS` when the client is connected to mainnet and **throws otherwise** — there is no safe default for another network, and a wrong one would either refuse every pool or trust an arbitrary deployer. Pass the zero address for a type to disable it. Binding one creator per type matters: the account that deployed the stableswap pools also created the constant product *factory*, so merely being in the set is not enough.

`type` is `""` for anything that fails, and nothing in the batch aborts it: app ids that do not exist or have been deleted, app ids below 256 (which `simulate` refuses to attach as resources, since they are ambiguous with foreign-array indexes), apps that are not pools (PACT's own factories and vault), and lookalike pools from an untrusted creator all come back zeroed. **Unlike Tinyman, `asset1Id === 0` is normal** — ALGO is PACT's *primary* asset — so the "is this a pool" test is `type !== ""`. ALGO is reported with the unit name `"ALGO"`, and an asset that has since been destroyed keeps its id but has an empty unit name.

`asset1` / `asset2` are PACT's primary / secondary assets. Note that the unit names are read from the ASAs, so `asset1UnitName + "/" + asset2UnitName` is not always PACT's own display label, which comes from the LP token name and can carry suffixes such as `"USDC/goUSD [SI]"`.

```ts
const pools = await sdk.getPactInfo([1073547054, 885102197, 3661371688])
pools.get(1073547054n)
// { type: "CONSTANT_PRODUCT", asset1Id: 31566704n, asset1UnitName: "USDC", asset2Id: 386192725n, asset2UnitName: "goBTC", feeBps: 30n }
pools.get(3661371688n)
// { type: "MANAGED_WEIGHTED", asset1Id: 0n, asset1UnitName: "ALGO", asset2Id: 2994233666n, asset2UnitName: "POW", feeBps: 36n }

// off mainnet, or to pin the creators yourself:
import { MAINNET_PACT_POOL_CREATORS } from "abel-ghost-sdk"
await sdk.getPactInfo([1073547054], { ...MAINNET_PACT_POOL_CREATORS, MANAGED_WEIGHTED: myCreator })
```

Batched 42 pools per simulate: each pool can cost 3 of the group's 128 resource references (the app itself plus its two assets). The creators travel as ARC-4 addresses in the app args, so they cost no references.

## Running the examples

The [`examples/`](examples) directory has runnable MainNet scripts. Build first from the repo root (`algokit project run build`), then from `projects/sdk`:

```bash
npx tsx examples/get-simple.ts          # asset metadata
npx tsx examples/get-label.ts           # asset labels + tiny labels
npx tsx examples/get-all-assets.ts      # all registry asset ids
npx tsx examples/get-blk-time-tc.ts     # block times & tx counters
npx tsx examples/get-auth-addrs.ts      # auth/rekey addresses
npx tsx examples/get-tinyman-info.ts    # tinyman pool escrows
npx tsx examples/get-pact-info.ts       # pact pool apps

# get-auth-addrs with no args pulls accounts rekeyed to a known address from the
# indexer and verifies them; or pass addresses explicitly:
npx tsx examples/get-auth-addrs.ts <ADDR1> <ADDR2> ...

# get-tinyman-info with no args pulls 420 accounts rekeyed to the Tinyman v2 app
# account from the indexer and verifies each is a valid pool escrow; or pass
# escrow addresses explicitly:
npx tsx examples/get-tinyman-info.ts <ADDR1> <ADDR2> ...

# get-pact-info with no args checks 100 pools from PACT's API (used only as an
# oracle) plus fixtures for managed weighted pools and for app ids that must be
# refused; or pass pool app ids explicitly:
npx tsx examples/get-pact-info.ts <APPID1> <APPID2> ...
```
