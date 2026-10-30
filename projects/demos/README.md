# Demos on a dtalgorand node

Five demos of the Abel ghost SDK on a dtalgorand (DT) node: an algod that reads **any past round since genesis**, lists **every change** to an account, app or box (`/versions`), and answers **read-only queries** (`POST /v2/query`): the reader contract's app calls, each run alone with the node's per-call budget, at many rounds in one request. Each demo prints a summary with request counts and timings, and writes a self-contained HTML page with charts, plus JSON and CSV, to `out/`.

```bash
# from the repo root, once
pnpm install
algokit project run build

# then, from projects/demos
pnpm balances     # genesis accounts since round 1
pnpm tinyman      # every Tinyman pool, and selected pools tick by tick
pnpm abel         # Abel registry: every labelled asset, packing sweep, label history
pnpm vitals       # supply, online stake, block time and TPS since genesis
pnpm rekeys       # when 2,000 accounts were rekeyed, to the block
pnpm packing      # how many items to put in an app call (run `pnpm tinyman` once first)
```

Open `out/<demo>.html` in a browser. The pages load Chart.js from cdnjs; everything else is inline.

## Configuration

| variable | default | |
|---|---|---|
| `DT_ALGOD_SERVER` | `https://mainnet-api-dt.d13.co` | the DT node, with its port if it isn't the protocol's own |
| `DT_ALGOD_TOKEN` | none | its API token |
| `INDEXER_SERVER` | nodely's MainNet indexer | only for listing Tinyman pool escrows, which algod can't list (cached in the temp dir) |
| `REQUEST_LOG=1` | off | log each query and `/versions` request |

The demos read only through the node's read-only queries, and stop with the reason if the node is stock algod, has queries off (`GET /v2/capabilities` reports no `query`), or the forks aren't loaded. Each prints the node's query limits first: calls and rounds per request, and the opcode budget, logs and ledger state per call. A simulate request would be a bug, since the SDK's query backend never simulates, so a demo that sends one stops.

The timings below are from the local MainNet query node (query limits: 1,024 calls and 64 rounds per request, 320,000 budget per call), with one run each, while other clients were using the node too.

## The demos

### `balances-over-time.ts`: balances since genesis

```bash
pnpm balances [--genesis | addr … | --file addrs.txt] [--from 1] [--to <tip>] [--samples 256] [--top 4] [--supply-samples 256]
```

The 102 MainNet genesis accounts (from the node's `/genesis`), or any accounts, at 256 rounds from round 1 to now.

- **Sampled:** `sdk.getBalanceInfoAtRounds(accounts, rounds)`. `--samples` takes any multiple of the rounds the node takes per query request (its query `maxRounds`, read from the node: 64 on the local query node, 16 on a node with the default config): the rounds are dealt into that many parts (every 4th round for 256 rounds at 64, so each part spans the whole range), and the parts go as one query each, all at once. 256 rounds × 102 accounts took 4 queries and about 0.5 s, and 1,024 rounds 16 queries and 2.5 s; on a node that takes 16 rounds per query, 256 rounds took 16 queries and 1.3 s. The reader contract is AVM 11, which MainNet only allows from round ~46.5M; older rounds run under the latest protocol, and the page lists the node's notes on them.
- **Exact:** every balance change of the largest accounts, from `/v2/accounts/{addr}/versions`, drawn as step lines under the samples.
- **Supply:** total money and the exact online stake at the same rounds (`/v2/ledger/supply?round=`). That is one request per round, so with more than `--supply-samples` (256) rounds it is read at that many of them, evenly spread, 8 requests at a time.
- **Check:** sampled reads against the node's own `GET /v2/accounts/{addr}?round=`.

### `tinyman-pools.ts`: every pool, and selected pools tick by tick

```bash
pnpm tinyman [--pools USDC,goBTC,xALGO | --pools <escrow>,…] [--days 7] [--no-global] [--refresh]
```

- **Every pool:** the ~17,300 Tinyman v2 escrows checked in one chunked call (9 queries, about 1.3 s), then every pool's state now and a day ago in one `atRounds` call: TVL, 24h moves and 24h volume of the ALGO pairs. Asset names and the Abel `pv` label come from the same reader.
- **Selected pools:** every change to each pool over `--days` (each swap, mint, burn and fee claim; ~1,400 for ALGO/USDC in a day) from the escrow's local-state `/versions`, beside hourly TWAP and volume from the reader at each hour. The reader's reserves at each hour must equal the last change before it: they do, every time.
- **With and without volume:** hourly prices alone are one read per hour, in as few queries as the node's rounds per request allow (2 queries for a day of ALGO/USDC, with the asset decimals). Volume estimation also reads inside every hour whose protocol fees were claimed, until it finds the claim's block: 18 queries for a day of ALGO/USDC, whose fees are claimed every few hours. Both give the same prices. Each chart lists the reads, queries and time it took.

### `abel-assets.ts`: the Abel registry

```bash
pnpm abel [--reps 5]
```

- Every asset of registry `2914159523` (1,352) through `getAssetsTiny`, which reads each asset's params and asks the registry, with an inner app call, about the `pv` label: one query. Checked against the registry's own boxes.
- **Packing sweep:** assets per app call (8–254), median of `--reps` runs. A query runs each app call alone in its group, so how app calls would be grouped makes no difference, and each asset's inner app call keeps an app call to 256 assets. The whole registry is one query at every size; 8 per app call was the slowest (~130 ms against 50–70 ms from 16 up).
- **Baseline:** the same labels straight from the boxes, `include=values`, in one request.
- **History:** labelled assets over time, from `/v2/applications/{id}/boxes/versions`.
- **AVM 13:** not applicable yet. An AVM 13 build of the reader fails the node's program check at every round, the latest included (`branch target outside of program`), and one app arg is still capped at 4,096 bytes.

### `chain-vitals.ts`: MainNet's vital signs

```bash
pnpm vitals [--samples 256] [--span 1000] [--supply-samples 256]
```

The 1,000 block headers before each of 256 rounds since genesis, through `getRecentBlockTimesAndTc`, which reads relative to the round it runs at, so the same call runs at every sample: **256,000 headers in 4 queries** of 64 rounds (~12.5 s). Block time, gaps and TPS per era, with total money, online money and the exact online stake.

### `rekey-forensics.ts`: rekeys to the block

```bash
pnpm rekeys [addr … | --file addrs.txt | --recent 2000] [--check 60]
```

The senders of the latest blocks (or any accounts): their auth address at 256 rounds since genesis (for 200 accounts, 51,200 reads in 4 queries, ~2 s), then 256 rounds inside each interval where two samples differ, down to the block in about four levels. A sample of accounts is checked against their exact `/versions` history, which also shows the one thing the search can't see: a rekey undone between two samples.

### `arg-packing.ts`: filling app calls

```bash
pnpm packing [--reps 3] [--accounts 17000] [--rounds 32]
```

One app arg holds at most 4,096 bytes, but an app call carries up to 16 KB on MainNet now, so the reader's balance and asset methods take four array arguments. The demo times ghostkit's one-array chunking (2 KB and 4 KB) against packing 1, 2 or 4 arrays per app call by hand, for 17,000 balances now, 2,000 balances at 32 rounds, and the 1,352 Abel assets. A query runs each app call alone with the node's per-call budget, so what a layout changes is how many app calls a read takes. One run on the local query node:

- **Balances now** (17,000 accounts, every layout in the same 9 queries of up to 2,048): 2 KB per app call (63, ghostkit's old default) 477 ms; one 4 KB array (127, the new default) 219 ms; 4 arrays × 127 (508 per app call) 199 ms.
- **Balances at 32 rounds** (2,000 accounts, one query): 2 KB per app call 1.6 s, every other layout 0.75–1 s.
- **Abel assets:** one query whatever the layout, 36–51 ms.

## More ideas

Not built yet:

- **ASA holders over time:** every holder of USDC at several past days with `getAssetHoldingsAtRounds` (a query needs no resource references, so an app call takes as many holders as its args hold), for circulation, concentration and joiners/leavers. Needs an indexer for the holder list.
- **Protocol what-if:** the same read under each round's own protocol and under the latest, era by era, with the node's notes on what the old rounds never produced.
- **PACT pool history:** every change to a PACT pool's global state from `/v2/applications/{id}/versions`, like the Tinyman tick history.
- **Abel labels vs liquidity:** Tinyman TVL of `pv`-labelled assets over time against unlabelled ones.

## Findings along the way

- algosdk's ABI decoder ignores `byteOffset` for dynamic tuples, so it misreads logs that are views into a response. ghostkit decodes a copy of each log.
- The DT node refuses request bodies over 1 MB, which `GET /v2/capabilities` doesn't report. The SDK splits inputs into requests of at most 2,048 items: the 17,295 Tinyman escrows go in 9 queries.
- A query gives each app call the node's `maxCallBudget` (320,000 here). ghostkit only queries a read whose extra opcode budget and 700 per app call of a full group fit in it, so the SDK caps the budget it asks for on a node with queries.
- The node admits a limited number of queries at once (its query parallelism) and answers more with 503 and `Retry-After`; the client retries them. With other clients on the node, reads that send many queries at once (a rekey search level, every pool at two rounds) see some of these retries.
- puya-ts drops JSDoc tags, so a `@ghostkit-chunk` line in a method's doc comment never reaches the ARC-56 description. The tag works inline, in backticks.
