# vendor

The dtalgorand forks of algosdk and algokit-utils, and the ghostkit build that generates the reader client, until they are published. `pnpm-workspace.yaml` overrides `algosdk` and `@algorandfoundation/algokit-utils` with the fork tarballs, so the workspace loads a single copy of each.

- `dtalgosdk-3.9.0-dt.4.1.0.0.tgz`: dtalgosdk, the fork of js-algorand-sdk (`DTAlgodClient`), built from js-algorand-sdk `28edb86`.
- `d13co-dt-algokit-utils-9.2.3-dt.4.1.0.0.tgz`: `@d13co/dt-algokit-utils`, the fork of algokit-utils-ts (`algorand.dt`, `algorand.simulate`, `algorand.query`, `algorand.client.capabilities()`), built from algokit-utils-ts `bb39063a`.
- `ghostkit-0.1.0-dt.4.tgz`: ghostkit, which `projects/contracts` runs to generate `AbelReaderSDK.ts`. It detects a dtalgorand node from `GET /v2/capabilities`. Build time only: the generated client inlines its runtime and imports only algosdk and algokit-utils.

These are the current dtalgorand release. Older forks, and dtalgorand nodes from before `GET /v2/capabilities`, read as stock.

To refresh, put the new tarballs here under new file names (a tarball whose contents change under the same name is served from pnpm's cache, since the lockfile pins its integrity), update `pnpm-workspace.yaml`, `projects/contracts/package.json` and `projects/demos/package.json`, run `pnpm install`, and rebuild from the root with `algokit project run build`.
