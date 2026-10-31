# vendor

The ghostkit build that generates the reader client, until it is published. The dtalgorand forks of algosdk and algokit-utils come from npm (`dt-algosdk` 3.9.0-dt.4.1.0.0 and `@d13co/dt-algokit-utils` 9.2.3-dt.4.1.0.0), which `pnpm-workspace.yaml` overrides `algosdk` and `@algorandfoundation/algokit-utils` with, so the workspace loads a single copy of each.

- `ghostkit-0.1.0-dt.5.tgz`: ghostkit, which `projects/contracts` runs to generate `AbelReaderSDK.ts`. It detects a dtalgorand node from `GET /v2/capabilities`. Build time only: the generated client inlines its runtime and imports only algosdk and algokit-utils.

This is the current dtalgorand release. Older forks, and dtalgorand nodes from before `GET /v2/capabilities`, read as stock.

To refresh ghostkit, put the new tarball here under a new file name (a tarball whose contents change under the same name is served from pnpm's cache, since the lockfile pins its integrity) and update `projects/contracts/package.json`. To move to new forks, update their exact versions in `pnpm-workspace.yaml` and `projects/demos/package.json`. Then run `pnpm install`, and rebuild from the root with `algokit project run build`.
