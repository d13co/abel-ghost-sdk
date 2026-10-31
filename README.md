# Abel Ghost SDK

Tiny [Ghostkit](https://github.com/d13co/ghostkit) SDK for [Abel](https://github.com/Algorand-Developer-Retreat/abel), allowing [algo.surf](https://algo.surf) to batch look up on-chain data on any network, while also supporting the Abel label registry on Mainnet.

The reader contract lives in [`projects/contracts`](projects/contracts), the published SDK in [`projects/sdk`](projects/sdk), and demos with charts on a dtalgorand node (reads at any past round, change histories, many rounds per simulate) in [`projects/demos`](projects/demos).

## What is Ghostkit?

[Ghostkit](https://github.com/d13co/ghostkit) is a toolkit for running **read-only smart-contract calls without deploying anything**. The contract's logic runs entirely inside an Algorand `simulate` request, so reads are:

- **Free** — no transaction fees, no minimum balance, no funded account required.
- **Deployment-free** — you don't have to create (or maintain) an app on-chain. Ghostkit simulates an app-_create_ transaction carrying the compiled program, the AVM executes the read-only method, and the results are read back from the transaction logs. (It can also target an already-deployed app ID if you have one.)
- **Batched** — a single method can loop over many inputs and `log()` one ARC-4 encoded result per item. One `simulate` round-trip returns hundreds of results, and the SDK chunks larger requests automatically.
- **Network-agnostic** — because nothing is deployed, the same contract code runs against LocalNet, TestNet or MainNet.

In this repo the [`AbelReader`](projects/contracts/smart_contracts/abel_reader/contract.algo.ts) contract uses this pattern to expose batch readers such as `getBalanceInfo`, `getAssetsTiny`, `getAuthAddrs`, `getAssetHoldings`, `getTinymanPoolStates` and `getRecentBlockTimesAndTc`. Each method iterates over its inputs, logs an encoded result per item, and Ghostkit harvests those logs in one simulate call. A `@ghostkit-chunk` tag in each method's doc comment tells Ghostkit how to split large inputs across app calls and groups. Puya-ts drops JSDoc tags, so the tag sits inline in backticks.

The contract build runs `ghostkit build` over the generated ARC-56 spec to produce the typed `AbelReaderSDK.ts`, which the SDK wraps with a friendlier, chunked API.

## Build

The canonical build process is, **from the repo root**:

```bash
algokit project run build
```

This runs the workspace build across both sub-projects **in order** (`contracts` then `sdk`, as configured in [`.algokit.toml`](.algokit.toml)):

1. **`contracts`** — compiles the `AbelReader` contract with PuyaTs, then runs `ghostkit build` over the generated ARC-56 spec to (re)generate the typed `AbelReaderSDK.ts`.
2. **`sdk`** — copies the freshly generated `AbelReaderSDK.ts` into `projects/sdk/src/generated/` and compiles the SDK with `tsc`.

The contracts build runs Ghostkit 0.1.0-dt.5, vendored in [`vendor/`](vendor), which generates the dtalgorand-aware runtime: reads at past rounds, queries, batching, and chunking. The dtalgorand forks of algosdk and algokit-utils come from npm (`dt-algosdk`, `@d13co/dt-algokit-utils`) and are installed through `pnpm-workspace.yaml` overrides, so the workspace loads one copy of each.

Always build from the root with this command so the SDK picks up contract changes — running the sub-project builds out of order can leave the SDK compiled against a stale generated client. After changing [`contract.algo.ts`](projects/contracts/smart_contracts/abel_reader/contract.algo.ts), re-run `algokit project run build` to propagate the new ABI through to the SDK.

## Usage

See the **[SDK README](projects/sdk/README.md)** for installation, the full method reference, and runnable examples.

Runnable example scripts live in [`projects/sdk/examples`](projects/sdk/examples).

## Notes

- For a more fleshed-out project in a similar vein, see [reti-ghost-sdk](https://github.com/d13co/reti-ghost-sdk).
- Mainnet Abel registry app ID: `2914159523`.
- An optional deployed ghost app exists at ID `3381542955` (not on the latest contract, missing `getBalanceInfo` and `getAuthAddrs`). The SDK does not require it — it defaults to the deployment-free ghost path.
