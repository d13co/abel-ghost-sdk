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

## Running the examples

The [`examples/`](examples) directory has runnable MainNet scripts. Build first from the repo root (`algokit project run build`), then from `projects/sdk`:

```bash
npx tsx examples/get-simple.ts          # asset metadata
npx tsx examples/get-label.ts           # asset labels + tiny labels
npx tsx examples/get-all-assets.ts      # all registry asset ids
npx tsx examples/get-blk-time-tc.ts     # block times & tx counters
npx tsx examples/get-auth-addrs.ts      # auth/rekey addresses

# get-auth-addrs with no args pulls accounts rekeyed to a known address from the
# indexer and verifies them; or pass addresses explicitly:
npx tsx examples/get-auth-addrs.ts <ADDR1> <ADDR2> ...
```
