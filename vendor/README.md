# vendor

The dtalgorand dt5 builds this repo uses until they are published: ghostkit, and the forks of algosdk and algokit-utils, which `pnpm-workspace.yaml` overrides `algosdk` and `@algorandfoundation/algokit-utils` with, so the workspace loads a single copy of each.

- `dt-algosdk-3.9.0-dt.5.2.0.0-4892b5e7.tgz`: dt-algosdk, js-algorand-sdk `05457f0`.
- `d13co-dt-algokit-utils-9.2.3-dt.5.2.0.0-5d34a1ef.tgz`: dt-algokit-utils, algokit-utils-ts `d06d1de7`.
- `ghostkit-0.1.0-dt.7.tgz`: ghostkit, dt-stack `54043ac`, which `projects/contracts` runs to generate `AbelReaderSDK.ts`. It detects a dtalgorand node from `GET /v2/capabilities`. Build time only: the generated client inlines its runtime and imports only algosdk and algokit-utils.

These target dtalgorand dt5 (v5.0.5-dt5, `c06d73342`), whose simulate takes one round per request and dropped the resource-limit multiplier. Older forks, and dtalgorand nodes from before `GET /v2/capabilities`, read as stock.

To refresh ghostkit, put the new tarball here under a new file name (a tarball whose contents change under the same name is served from pnpm's cache, since the lockfile pins its integrity) and update `projects/contracts/package.json`. To move to new forks, do the same with their tarballs (or, once published, their exact npm versions) in `pnpm-workspace.yaml` and `projects/demos/package.json`. Then run `pnpm install`, and rebuild from the root with `algokit project run build`.
