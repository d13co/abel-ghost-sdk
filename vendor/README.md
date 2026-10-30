# vendor

The dtalgorand forks of algosdk and algokit-utils, until they are published. `pnpm-workspace.yaml` overrides both packages with these tarballs, so the workspace loads a single copy of each.

- `algosdk-3.8.0-dt.1.tgz`: `npm pack` of the `dtalgorand` branch of js-algorand-sdk (`DTAlgodClient`).
- `algorandfoundation-algokit-utils-9.2.3-dt.1.tgz`: `npm pack` of the built `dist/` of the `dtalgorand` branch of algokit-utils-ts (`algorand.dt`, `algorand.simulate`).

Both tarballs are currently built from a `perf/simulate-decode` branch in each fork (worktrees at `.claude/worktrees/perf-decode`), on top of the commits the dt.1 tarballs came from (js-algorand-sdk `7156603`, algokit-utils-ts `105cc685`). Each adds one cache that makes simulate responses with many rounds cheaper to decode: algosdk remembers addresses whose checksum it has checked, and algokit-utils hashes a built group's transaction IDs once instead of once per round. Neither change is on the forks' `dtalgorand` branches yet.

To refresh, rebuild each fork and pack it again into this directory, then run `pnpm install`.
