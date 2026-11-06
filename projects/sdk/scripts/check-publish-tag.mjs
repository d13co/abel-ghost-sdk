// Refuses to publish a dt-line version (0.1.0-dt.N) under any dist-tag but `beta`: as `latest` it would replace the
// stable SDK for everyone running `npm install abel-ghost-sdk`. Releases go through CI (see the repo README); this
// guards a publish by hand.
import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const tag = process.env.npm_config_tag || "latest"

if (version.includes("-") && tag !== "beta") {
  console.error(`abel-ghost-sdk ${version} is a dt-line prerelease: publish it with --tag beta, not ${tag}.`)
  process.exit(1)
}
