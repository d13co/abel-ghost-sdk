# Abel Ghost SDK

Tiny [Ghostkit](https://github.com/d13co/ghostkit) SDK for [Abel](https://github.com/Algorand-Developer-Retreat/abel). It batches read-only on-chain lookups (balances, asset metadata and labels, block times, auth/rekey addresses, Tinyman and PACT pools) into single `simulate` calls — **no deployment, no fees, on any network**.

On a [dtalgorand](#dtalgorand-nodes) node it also reads **any past round since genesis**, reads **many rounds in one request**, and reads the **exact change history** of pools and the Abel registry.

For background on _how_ the ghost (simulate-based, deployment-free) calls work, and the canonical build process (`algokit project run build` from the repo root), see the [root README](../../README.md).

## Install

```bash
npm install abel-ghost-sdk
# peer deps
npm install @algorandfoundation/algokit-utils algosdk
```

With stock algosdk and algokit-utils every read works at recent rounds. Past rounds, many rounds per request and change histories need a [dtalgorand](#dtalgorand-nodes) node and its forks of both, which aren't on npm yet: `dtalgosdk` 3.9.0-dt.4.1.0.0 and `@d13co/dt-algokit-utils` 9.2.3-dt.4.1.0.0, whose tarballs are in this repo's [`vendor/`](../../vendor). Copy them into your repo and install them under the stock names, so that exactly one copy of each loads (your code, this SDK and any wallet library must share them):

```yaml
# pnpm: pnpm-workspace.yaml, or "pnpm": { "overrides": { ... } } in package.json
overrides:
  algosdk: file:vendor/dtalgosdk-3.9.0-dt.4.1.0.0.tgz
  '@algorandfoundation/algokit-utils': file:vendor/d13co-dt-algokit-utils-9.2.3-dt.4.1.0.0.tgz
```

With npm, set your `algosdk` and `@algorandfoundation/algokit-utils` dependencies to the tarballs and add `"overrides": { "algosdk": "$algosdk", "@algorandfoundation/algokit-utils": "$@algorandfoundation/algokit-utils" }`. The forks' versions are prereleases, which the stock peer ranges don't accept, so with npm also set `legacy-peer-deps=true` in `.npmrc`.

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
  registryAppId,       // number | bigint — Abel label registry app id (MainNet: MAINNET_ABEL_REGISTRY_APP_ID, 2914159523). Needed for label methods.
  ghostAppId,          // bigint — optional deployed ghost app id. Omit to use the deployment-free ghost path.
  readerAccount,       // string — sender used for simulation. Defaults to the network's fee sink, funded at every round.
  backend,             // 'auto' (default) | 'query' | 'dt' | 'stock' | a ghostkit backend — how reads are sent; 'auto' uses a dtalgorand node's read-only queries when it has them on, else its extended simulate, else one simulate per group. 'query' and 'dt' throw on stock algod.
  ghostFee,            // what each simulated group offers in fees; default 1 Algo, never paid.
  cacheParamsTimeout,  // number — ms that reads at the latest round reuse suggested params for. Defaults to 3,000.
  maxItemsPerRequest,  // number — most items one read sends in one request; larger inputs are split and run concurrently. Default 2,048, fewer if their bytes would come near 1 MB.
  debug,               // boolean — log ghostkit's diagnostics of each call.
})
```

Inputs of any size are split across app calls and groups by ghostkit, sized to the node's limits: on a stock node a group can reference 128 accounts, assets or apps; a dtalgorand node can multiply that (128× on the d13 node), and takes up to 16 groups per request. Ghostkit fills up to 4 KB of app args per app call (127 addresses), which MainNet's current protocol allows. Each read method also takes `{ chunk }` to override how its input is split, e.g. `{ chunk: { arg: "accounts", maxArgBytes: 2048 } }` for a network that still limits an app call to 2 KB of args.

The reader's `getBalanceInfo` and `getAssetsTiny` take four array arguments, since one app arg holds at most 4,096 bytes while an app call can carry 16 KB. `getBalanceInfo` and `getAssetsTinyLabels` (and their `…AtRounds` forms) take `{ packing: { perArg, args, perGroup? } }` to spread the items over them by hand: `{ perArg: 127, args: 4 }` puts 508 addresses in each app call. A read sends at most 2,048 items per request, about one full group at a 128× multiplier, and fewer if their bytes would come near a dtalgorand node's 1 MB limit; larger inputs become concurrent requests, which ran faster on the d13 node than fewer, larger ones. `maxItemsPerRequest` overrides it.

## Past rounds

Every read takes `{ round }`, and has an `…AtRounds(…, rounds)` form that reads the same items at many rounds:

```ts
// as of the end of round 40,000,000
const then = await sdk.getBalanceInfo(accounts, { round: 40_000_000 })

// at 256 rounds since genesis, in as few requests as the node allows
const history = await sdk.getBalanceInfoAtRounds(accounts, roundRange(1, 66_000_000, 260_000))
for (const r of history) {
  if (r.ok) console.log(r.round, r.value.get(accounts[0])?.balance)
  else console.error(r.round, r.error.message)
}
```

A stock node only simulates its last few rounds (usually 4). A dtalgorand node with time travel simulates any round since genesis, and packs up to its `max-rounds` rounds into one request however far apart they are. The reader contract is AVM 11, which MainNet only allows from round ~46.5M: older rounds run under the latest protocol, as if it took effect right after the round. Each round's result carries a `protocolOverride` saying whether that applied, with notes on any data the old round never produced.

`getNode()` says what ghostkit found about the node (from `GET /v2/capabilities`, which every dtalgorand node serves and stock algod doesn't), and `getBackend()` which backend the reads use: `query`, `dt` or `stock`.

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

### `getAllAssetIDs({ round }?): Promise<bigint[]>`

Every asset id known to the configured Abel registry (reads the registry's box names). Returns `[]` without a `registryAppId`.

```ts
const ids = await sdk.getAllAssetIDs()
```

### `getAllAssetLabels({ round }?): Promise<Map<bigint, string[]>>` and `getAbelLabels({ round }?): Promise<AbelLabel[]>`

**dtalgorand only** (they list box values, `include=values`). Every registered asset's labels, and the label definitions (`{ id, name, url, numAssets, numOperators }`), each in one request. Gets every label, where `getAssetsTinyLabels` only checks `pv`, but no asset params.

### `getAbelLabelHistory({ minRound, maxRound }?): Promise<AbelLabelChange[]>`

**dtalgorand only.** Every change to the assets' labels, oldest first, from the registry's box history: `{ round, timestamp, assetId, labels, deleted }`.

### `getAssetHoldings(assetId, accounts, { round }?): Promise<Map<string, AssetHolding | undefined>>`

One asset's holding (`{ optedIn, frozen, balance }`) in each of many accounts; `undefined` when not opted in. Asset ids below 256 are refused, since a ghost read can't reference them. `getAssetHoldingsAtRounds` reads them at many rounds.

### `getBlockTimesAndTc(firstRound, lastRound): Promise<BlockRoundTimeAndTc[]>`

Timestamp and transaction counter for a range of blocks, at most the ~1,000 before `lastRound`. Each entry is `{ rnd: bigint, ts: number, tc: bigint }`.

```ts
const { lastRound } = await algorand.client.algod.status().do()
const blocks = await sdk.getBlockTimesAndTc(lastRound - 999n, lastRound)
console.log(blocks[0]) // { rnd, ts, tc }
```

### `getBlockTimesAndTcAtRounds(rounds, span): Promise<AtRounds<BlockRoundTimeAndTc[]>>`

The `span` blocks up to each of `rounds`. The reader reads relative to the round it runs at, so on a dtalgorand node every round shares one request: 256 rounds of 1,000 blocks each is one simulate.

### `getTinymanInfo(lpEscrows: string[], tinymanAppId?: number | bigint, { round }?): Promise<Map<string, TinymanInfo>>`

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

Each escrow can cost 3 resource references (the account plus its two assets), which sizes the groups. `getTinymanInfo` takes `{ round }` too.

### `getTinymanPoolStates(lpEscrows, tinymanAppId?, { round }?): Promise<Map<string, TinymanPoolState | undefined>>`

Each pool's state from its escrow's local state: reserves, issued pool tokens, unclaimed protocol fees, fee settings and the cumulative prices of Tinyman's oracle, with the round and its block timestamp. `undefined` for an account that is not opted in to Tinyman. `getTinymanPoolStatesAtRounds(lpEscrows, rounds)` reads them at many rounds.

### `getTinymanPriceHistory(lpEscrows, rounds, tinymanAppId?, { volume }?): Promise<Map<string, TinymanPriceInterval[]>>`

Time-weighted average prices, spot prices and swap volume of each pool between consecutive `rounds`. The volume comes from the growth of the protocol fees; an interval in which they were claimed is split until the claim is down to its block. Helpers: `twap`, `vwap`, `priceInterval`, `volumeEstimate`, `cumulativePricesAt`, `roundRange`.

### `getTinymanPoolHistory(lpEscrow, { minRound, maxRound, tinymanAppId }?): Promise<TinymanPoolVersion[]>`

**dtalgorand only.** Every change to one pool — each swap, mint, burn and fee claim — from the escrow's local state history (`/versions`), as `{ round, timestamp, deleted, state }`. Exact, where the reads above sample.

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

Each pool can cost 3 resource references (the app itself plus its two assets), which sizes the groups. The creators travel as ARC-4 addresses in the app args, so they cost no references.

## dtalgorand nodes

A dtalgorand node is an algod with extra API features: reads at any past round, `/versions` change histories, and a simulate that takes several groups and several rounds per request, with a multiplier on the resources a group can reference. The SDK uses them through the dtalgorand forks of algosdk and algokit-utils, which this repo vendors under [`vendor/`](../../vendor) and installs through `pnpm-workspace.yaml` overrides. With stock packages, or on a stock node, everything still works the stock way, one group per request at recent rounds; the methods marked **dtalgorand only** need both.

A dtalgorand node refuses request bodies over 1 MB, which `GET /v2/capabilities` doesn't report, and ghostkit packs up to 16 full groups per request. The SDK splits each read into requests of at most 2,048 items and well under 1 MB (or `maxItemsPerRequest`), and asks for the node's most extra opcode budget, since a full group of a batch reader needs more than ghostkit's default. On a node with queries on, it asks for no more than a query's per-call budget allows (`maxCallBudget` less 700 per app call of a full group), so that ghostkit queries the read rather than simulating it.

Only the current dtalgorand release is supported: older forks, and dtalgorand nodes from before `GET /v2/capabilities`, read as stock.

For demos of all this against MainNet, with charts, see [`projects/demos`](../demos).

## Running the examples

The [`examples/`](examples) directory has runnable MainNet scripts. Build first from the repo root (`algokit project run build`), then from `projects/sdk`:

```bash
npx tsx examples/get-simple.ts          # asset metadata
npx tsx examples/get-balance-info.ts    # balances, checked against the indexer
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
