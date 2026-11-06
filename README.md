# Abel Ghost SDK

Tiny [Ghostkit](https://github.com/d13co/ghostkit) SDK for [Abel](https://github.com/Algorand-Developer-Retreat/abel), allowing [algo.surf](https://algo.surf) to batch look up on-chain data on any network, while also supporting the Abel label registry on Mainnet.

The reader contract lives in [`projects/contracts`](projects/contracts), the published SDK in [`projects/sdk`](projects/sdk), and demos with charts on a dtalgorand node (reads at any past round, change histories, many rounds per query) in [`projects/demos`](projects/demos).

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

The contracts build runs Ghostkit 0.1.0-dt.8 from npm, which generates the dtalgorand-aware runtime: reads at past rounds, queries, batching, and chunking. It's build time only: the generated client inlines its runtime and imports only algosdk and algokit-utils. The dtalgorand dt5 forks of those come from npm (`dt-algosdk` 3.9.0-dt.5.2.0.0, `@d13co/dt-algokit-utils` 9.2.3-dt.5.2.0.0), pinned exactly and installed through `pnpm-workspace.yaml` overrides, so the workspace loads one copy of each. All three target dtalgorand dt5 (v5.0.5-dt5), whose simulate takes one round per request; older forks, and dtalgorand nodes from before `GET /v2/capabilities`, read as stock. To move to new versions, update their exact versions in `projects/contracts/package.json` (ghostkit), `pnpm-workspace.yaml` and `projects/demos/package.json` (the forks), run `pnpm install`, and rebuild from the root with `algokit project run build`.

Always build from the root with this command so the SDK picks up contract changes — running the sub-project builds out of order can leave the SDK compiled against a stale generated client. After changing [`contract.algo.ts`](projects/contracts/smart_contracts/abel_reader/contract.algo.ts), re-run `algokit project run build` to propagate the new ABI through to the SDK.

## Releasing a beta

This branch, `dtalgorand`, is the dt line of the SDK (`0.1.0-dt.N`), released to npm under the `beta` dist-tag: `npm install abel-ghost-sdk@beta` gets the latest dt release, and `npm install abel-ghost-sdk` keeps getting the stable SDK (`latest`, 0.0.x, from `main`).

GitHub Actions does the release, with [`.github/workflows/dt.yml`](.github/workflows/dt.yml). On every push and pull request to `dtalgorand` it checks the release metadata with `scripts/ci/dt-release.mjs`, builds the contracts (puya-ts and ghostkit, no AlgoKit CLI needed) and the SDK, fails if that changed any committed file (the contract artifacts or either copy of `AbelReaderSDK.ts`), and type-checks the contracts and the demos. The demos need a dtalgorand node, so run them yourself before a release. On a `v0.1.0-dt.N` tag it also publishes the packed SDK to npm under `beta`, with provenance, and creates a GitHub prerelease with the tarball.

1. Bump `version` in `projects/sdk/package.json` to the next `0.1.0-dt.N`. Bump it whenever the generated client changes, so that projects vendoring the tarball don't get a stale copy from their package manager's cache.
2. If a fork or ghostkit changed, update its exact version as described under [Build](#build), and in the SDK's peer ranges and both READMEs.
3. `algokit project run build`, run the demos against a dtalgorand node, and `node scripts/ci/dt-release.mjs check`, which fails if the version isn't `x.y.z-dt.N`, the dist-tag (`publishConfig.tag`) isn't `beta`, or the fork versions disagree across the workspace overrides, the demos, the SDK's peer ranges and both READMEs, or ghostkit isn't pinned exactly.
4. Commit, and merge to `dtalgorand` (a pull request whose Test check passes; repository admins can push directly). Then tag the commit on `dtalgorand` and push the tag: `git tag -s v0.1.0-dt.N` and `git push origin v0.1.0-dt.N`.
5. The workflow checks that the tag is on `dtalgorand` and matches the version (`node scripts/ci/dt-release.mjs check v0.1.0-dt.N` runs the same check locally), builds and checks again, and publishes with `npm publish --tag beta`. If the version is already on npm, it doesn't publish it again and only creates the GitHub release.

`projects/sdk`'s `prepublishOnly` refuses a dt version under any dist-tag but `beta`, so a publish by hand can't replace `latest` either.

### One-time setup

- **Rulesets.** `scripts/ci/apply-rulesets.sh` creates the rulesets in [`.github/rulesets/`](.github/rulesets/), or updates them by name: changes reach `dtalgorand` only through merged pull requests that pass the Test check and never by force push (repository admins can bypass it), `dtalgorand` can't be deleted, and `v*-dt.*` tags can't be moved or deleted. It needs `gh` logged in as a repository admin. `main` stays the default branch.
- **Trusted publisher.** The workflow publishes only through npm trusted publishing, with no token. `abel-ghost-sdk` is already on npm, so add the publisher in the package's settings on npmjs.com (Trusted publishing → GitHub Actions: owner `d13co`, repository `abel-ghost-sdk`, workflow `dt.yml`, environment `npm`, publishing allowed), or with npm 11.5.1 or later: `npm trust github abel-ghost-sdk --file dt.yml --repo d13co/abel-ghost-sdk --env npm --allow-publish`. npm drops a new trusted publisher if nothing is published with it within 2 days, so set it up when the first release is close.
- **Approval (optional).** The publish job runs in the GitHub environment `npm`, which GitHub creates on the first run. To approve each release by hand, add required reviewers to it under Settings → Environments.

## Usage

See the **[SDK README](projects/sdk/README.md)** for installation, the full method reference, and runnable examples.

Runnable example scripts live in [`projects/sdk/examples`](projects/sdk/examples).

## Notes

- For a more fleshed-out project in a similar vein, see [reti-ghost-sdk](https://github.com/d13co/reti-ghost-sdk).
- Mainnet Abel registry app ID: `2914159523`.
- An optional deployed ghost app exists at ID `3381542955` (not on the latest contract, missing `getBalanceInfo` and `getAuthAddrs`). The SDK does not require it — it defaults to the deployment-free ghost path.
