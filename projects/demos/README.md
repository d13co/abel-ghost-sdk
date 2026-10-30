# Demos on a dtalgorand node

Five demos of the Abel ghost SDK on a dtalgorand (DT) node: an algod that reads **any past round since genesis**, lists **every change** to an account, app or box (`/versions`), and simulates **many groups at many rounds in one request**, with more resources per group. Each demo prints a summary with request counts and timings, and writes a self-contained HTML page with charts, plus JSON and CSV, to `out/`.

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
| `DT_ALGOD_SERVER` | `http://10.114.0.27:4000` | the DT node, with its port. `:4000` goes through a load balancer; `:8100` is a DT node directly |
| `DT_ALGOD_TOKEN` | none | its API token |
| `INDEXER_SERVER` | nodely's MainNet indexer | only for listing Tinyman pool escrows, which algod can't list (cached in the temp dir) |
| `REQUEST_LOG=1` | off | log each simulate, query and `/versions` request |

The demos read through the node's extended simulate, and stop with an error if the node isn't a dtalgorand node or the forks aren't loaded. Every demo takes `--stock` to send its simulates the way a stock algod takes them: one group per request, 128 resources per group, and only the last few rounds; and `--query` to read through the node's read-only queries (`POST /v2/query`) instead.

## The demos

### `balances-over-time.ts`: balances since genesis

```bash
pnpm balances [--genesis | addr … | --file addrs.txt] [--from 1] [--to <tip>] [--samples 256] [--top 4] [--supply-samples 256]
```

The 102 MainNet genesis accounts (from the node's `/genesis`), or any accounts, at 256 rounds from round 1 to now.

- **Sampled:** `sdk.getBalanceInfoAtRounds(accounts, rounds)`. All 256 rounds × 102 accounts are **one simulate request**, about 2 s. `--samples` takes any multiple of the node's 256 rounds per request: the rounds are dealt into that many parts (every 4th round for 1,024, so each part spans the whole range), and the parts go as one request each, all at once. 1,024 rounds × 102 accounts take about 2.5 s in 4 requests. The reader contract is AVM 11, which MainNet only allows from round ~46.5M; older rounds run under the latest protocol, and the page lists the node's notes on them.
- **Exact:** every balance change of the largest accounts, from `/v2/accounts/{addr}/versions`, drawn as step lines under the samples.
- **Supply:** total money and the exact online stake at the same rounds (`/v2/ledger/supply?round=`). That is one request per round, so with more than `--supply-samples` (256) rounds it is read at that many of them, evenly spread, 8 requests at a time.
- **Check:** sampled reads against the node's own `GET /v2/accounts/{addr}?round=`.

### `tinyman-pools.ts`: every pool, and selected pools tick by tick

```bash
pnpm tinyman [--pools USDC,goBTC,xALGO | --pools <escrow>,…] [--days 7] [--no-global] [--no-compare] [--refresh]
```

- **Every pool:** the ~17,300 Tinyman v2 escrows checked in one chunked call (5 requests, a few seconds), then every pool's state now and a day ago in one `atRounds` call: TVL, 24h moves and 24h volume of the ALGO pairs. Asset names and the Abel `pv` label come from the same reader.
- **Stock vs DT:** the same check of 2,000 escrows on both backends: 1 request vs 48.
- **Selected pools:** every change to each pool over `--days` (each swap, mint, burn and fee claim; ~9,500 for ALGO/USDC in a week, in ~2 s) from the escrow's local-state `/versions`, beside hourly TWAP and volume from the reader at each hour. The reader's reserves at each hour must equal the last change before it: they do, every time.
- **With and without volume:** hourly prices alone are one read per hour, all in one request (2 requests with the asset decimals, ~0.3 s per pool, or for all three pools together). Volume estimation also reads inside every hour whose protocol fees were claimed, until it finds the claim's block: 97 requests and ~4 s for ALGO/USDC, whose fees are claimed every few hours. Both give the same prices. Each chart lists the reads, requests and time it took.

### `abel-assets.ts`: the Abel registry

```bash
pnpm abel [--reps 5] [--no-stock]
```

- Every asset of registry `2914159523` (1,352) through `getAssetsTiny`, which reads each asset's params and asks the registry, with an inner app call, about the `pv` label. Checked against the registry's own boxes.
- **Packing sweep:** assets per app call (8–254) × assets per group (≤32–256), on both backends, median of 5 runs. Small app calls cost the most (8 per call is ~3× slower); from 64 per app call up, with groups of 128 or more, the differences are within run-to-run noise, and the reader's chunk tag uses 128 per app call and per group. On DT the whole registry is 1 request against 22 on stock.
- **Baseline:** the same labels straight from the boxes, `include=values`, in one request.
- **History:** labelled assets over time, from `/v2/applications/{id}/boxes/versions`.
- **AVM 13:** not applicable yet. An AVM 13 build of the reader fails the node's program check at every round, the latest included (`branch target outside of program`, on `:4000` and `:8100` alike), and one app arg is still capped at 4,096 bytes.

### `chain-vitals.ts`: MainNet's vital signs

```bash
pnpm vitals [--samples 256] [--span 1000] [--supply-samples 256]
```

The 1,000 block headers before each of 256 rounds since genesis, through `getRecentBlockTimesAndTc`, which reads relative to the round it runs at: ghostkit moves the validity window to each round, so all **256,000 headers are one simulate request** (~5 s). Block time, gaps and TPS per era, with total money, online money and the exact online stake.

### `rekey-forensics.ts`: rekeys to the block

```bash
pnpm rekeys [addr … | --file addrs.txt | --recent 2000] [--check 60]
```

The senders of the latest blocks (or any accounts): their auth address at 256 rounds since genesis (512,000 reads, one request), then 256 rounds inside each interval where two samples differ, down to the block in about four levels. A sample of accounts is checked against their exact `/versions` history, which also shows the one thing the search can't see: a rekey undone between two samples.

### `arg-packing.ts`: filling app calls

```bash
pnpm packing [--reps 3] [--accounts 17000] [--rounds 32]
```

One app arg holds at most 4,096 bytes, but an app call carries up to 16 KB on MainNet now, so the reader's balance and asset methods take four array arguments. The demo times ghostkit's one-array chunking (2 KB and 4 KB) against packing 1, 2 or 4 arrays per app call by hand, for 17,000 balances now, 2,000 balances at 32 rounds, and the 1,352 Abel assets. On the d13 node:

- **Balances now** (17,000 accounts, every layout in the same 9 requests of 2,048): 2 KB per app call (63, ghostkit's old default) 832 ms; one 4 KB array (127, the new default) 756 ms; 4 arrays × 127 (508 per app call) 610 ms. The same 127-per-call layout packed by hand took 635 ms, so runs vary by ~100 ms, but fuller app calls were faster in every run. With requests of the same size, what costs is app calls; what made larger layouts slower in an earlier run was fewer, larger requests, which the node runs less in parallel.
- **Balances at many rounds** and **Abel assets:** every layout within noise. The Abel reader's inner app calls cap a group at 256 assets whatever the args.

## More ideas

Not built yet:

- **ASA holders over time:** every holder of USDC at several past days with `getAssetHoldingsAtRounds` (the 128× resource multiplier makes ~16,000 holdings per group), for circulation, concentration and joiners/leavers. Needs an indexer for the holder list.
- **Protocol what-if:** the same read under each round's own protocol and under the latest, era by era, with the node's notes on what the old rounds never produced.
- **PACT pool history:** every change to a PACT pool's global state from `/v2/applications/{id}/versions`, like the Tinyman tick history.
- **Abel labels vs liquidity:** Tinyman TVL of `pv`-labelled assets over time against unlabelled ones.

## Findings along the way

- algosdk's ABI decoder ignores `byteOffset` for dynamic tuples, so it misreads the extended simulate's logs, which are views into the response. The SDK copies each log before ghostkit decodes it.
- The DT node refuses request bodies over 1 MB (on `:4000` and `:8100` alike), which `GET /v2/capabilities` doesn't report; ghostkit packs 16 full groups of the reader per request, which goes over for ~17,000 escrows. The SDK splits inputs into requests of at most 2,048 items: for 17,295 pool states at 2 rounds, 9 such requests took 2.9 s against 4.3 s for 2 requests of ~8,600.
- ghostkit's default extra opcode budget (170,000) is too little for a full group of a batch reader at a 128× multiplier; the SDK asks for the node's most.
- puya-ts drops JSDoc tags, so a `@ghostkit-chunk` line in a method's doc comment never reaches the ARC-56 description. The tag works inline, in backticks.
