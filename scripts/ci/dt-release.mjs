#!/usr/bin/env node
// Checks the dt line's release metadata: the SDK version is x.y.z-dt.N and publishes under the `beta` dist-tag, the
// pinned dtalgorand forks and ghostkit agree across the workspace and the READMEs, and on a release tag (v<version>)
// the tag names the SDK version. CI runs it on every push; run it locally before tagging:
//   node scripts/ci/dt-release.mjs check v0.1.0-dt.3
import { readFileSync } from 'node:fs'

const [mode, tag = ''] = process.argv.slice(2)
if (mode !== 'check') {
  console.error('usage: node scripts/ci/dt-release.mjs check [v<version>]')
  process.exit(2)
}
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const json = (path) => JSON.parse(read(path))
const sdk = json('projects/sdk/package.json')
const demos = json('projects/demos/package.json')
const contracts = json('projects/contracts/package.json')
const workspace = read('pnpm-workspace.yaml')
const readme = read('README.md')
const sdkReadme = read('projects/sdk/README.md')
const errors = []

const version = sdk.version
if (!/^\d+\.\d+\.\d+-dt\.\d+$/.test(version)) errors.push(`projects/sdk/package.json's version ${version} isn't x.y.z-dt.N`)
if (sdk.publishConfig?.tag !== 'beta') errors.push(`projects/sdk/package.json's publishConfig.tag is ${JSON.stringify(sdk.publishConfig?.tag)}, not "beta"`)
if (tag && tag !== `v${version}`) errors.push(`the tag ${tag} doesn't match projects/sdk/package.json's version ${version}`)

// The forks: pinned exactly from npm in the workspace overrides, the same in the demos, accepted by the SDK's peer
// ranges, and named in both READMEs
const exact = /^npm:((?:@[^/@]+\/)?[^/@]+)@(\d+\.\d+\.\d+-[\w.]+)$/
for (const name of ['algosdk', '@algorandfoundation/algokit-utils']) {
  const line = workspace.match(new RegExp(`^\\s+'?${name.replace(/[/.]/g, '\\$&')}'?:\\s*(\\S+)\\s*$`, 'm'))
  const spec = line?.[1] ?? ''
  const m = spec.match(exact)
  if (!m) {
    errors.push(`pnpm-workspace.yaml overrides ${name} with ${JSON.stringify(spec)}, not an exact npm: prerelease`)
    continue
  }
  const [, fork, forkVersion] = m
  if (demos.dependencies?.[name] !== spec) {
    errors.push(`projects/demos/package.json has ${name} ${JSON.stringify(demos.dependencies?.[name])}, the workspace ${spec}`)
  }
  if (!(sdk.peerDependencies?.[name] ?? '').split('||').some((r) => r.trim() === `^${forkVersion}`)) {
    errors.push(`projects/sdk/package.json's peer range for ${name} doesn't include ^${forkVersion}`)
  }
  for (const [path, text] of [['README.md', readme], ['projects/sdk/README.md', sdkReadme]]) {
    if (!text.includes(`\`${fork}\` ${forkVersion}`)) errors.push(`${path} doesn't name \`${fork}\` ${forkVersion}`)
  }
  if (!sdkReadme.includes(`"${name}": "${spec}"`)) errors.push(`projects/sdk/README.md's install snippet doesn't have "${name}": "${spec}"`)
}

// ghostkit: pinned exactly (its build refuses any other installed version), and named in the README
const ghostkit = contracts.dependencies?.ghostkit ?? ''
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(ghostkit)) {
  errors.push(`projects/contracts/package.json has ghostkit ${JSON.stringify(ghostkit)}, not an exact version`)
} else if (!readme.includes(`Ghostkit ${ghostkit}`)) {
  errors.push(`README.md doesn't name Ghostkit ${ghostkit}`)
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
console.log(`abel-ghost-sdk ${version}${tag ? `, tag ${tag}` : ''}, ghostkit ${ghostkit}: OK`)
