# Identifying and authenticating PACT pools from on-chain data

How to decide, using only algod, whether an application is a genuine PACT pool,
and to pull its type, asset pair and swap fee out of global state. No PACT API.

Everything here was measured against mainnet. The PACT API was used *only* as an
independent oracle to check the results — the algorithm never consults it.

Why bother: today a pool is recognised by its LP token's *name*, and anyone can
mint an asset called `ALGO/USDC PACT LP Token` for a few hundred µALGO. Of the
**4384** assets on chain whose names match that pattern, **517 were not created
by PACT** — they are labelled `PACT …` today on the strength of a string.

## Trust roots

One creator per pool type. `creator` is stamped by consensus at application
creation and can never be changed, which makes it the only forgery-proof anchor
here.

| creator | authenticates | what it is |
|---|---|---|
| `E5QGPA7LWVAVUADJFSZ6TLKRT6LYINNNQGQFVCPNTBHJM7I2HRYGSJBEMM` | CONSTANT_PRODUCT (both versions) | escrow of factory **app 1072843805** |
| `PACTFIIFTBWHD52WFMKTSCDZWFVWZK4ZDSWIZHMROZLYD5PZFA4TLCWP7I` | STABLESWAP | PACT deployer account |
| `H2XDAFUDTEPTN24HNUAZI6RCKQ2KDIIO45U767FEHGSGSEGCWWOK4QEIXM` | MANAGED_WEIGHTED | escrow of factory **app 3656084442** |

Both factories trace back to PACT vanity accounts:

- `PACTFIIFTBWHD52W…` created the CONST factory (1072843805) and creates STBL pools directly.
- `PACTFISTBL54HYDTCGPOM4GQIJSAOFFB6HOSHICSY4AYJ6C4VXQ3OMXPCY` created the MW factory (3656084442) and MW vault (3656084807).

Secondary corroboration, constant across every CONST and STBL pool sampled
(v100 and v201 alike) but stored in *mutable* global state, so weaker than
`creator`:

- `ADMIN` = `KIRIMYBSL4EH4UQUUGBOG4S5RLBRJPJK4LG4SCFS6AXK2YCQDULANQH7V4`
- `TREASURY` = `L2BBPVEU5CYJYH3OOD3RRFX3JRABYTMW4B2ALKUFQXK5AORKSH4QVRIR6A`

## Global-state shapes

| kind | keys |
|---|---|
| CONSTANT_PRODUCT (v100 + v201) | `A, ADMIN, B, CONFIG, CONTRACT_NAME, FEE_BPS, L, LTID, PACT_FEE_BPS, TREASURY, VERSION` |
| STABLESWAP | the above plus `FUTURE_A, FUTURE_A_TIME, INITIAL_A, INITIAL_A_TIME, PRIMARY_FEES, SECONDARY_FEES` |
| MANAGED_WEIGHTED | `asset_a, asset_b, bootstrapped, factory, i, issued_lp, lp_asset, manager, manager_fee_bps, must_allowlist, pending_manager, protocol_fee_bps, reserve_a, reserve_b, swap_fee_bps, vault, weight_a` |
| legacy pool (not PACT-created) | `A, B, CONFIG, L, LTID` — note: no `FEE_BPS`, no `ADMIN` |
| CONST factory (1072843805) | `ADMIN, ALLOWED_FEE_BPS, ALLOWED_PACT_FEE_BPS, POOL_CONTRACT_VERSION, TREASURY` |
| MW factory (3656084442) | `admin, contract_manager, deployed_count, factory_version, paused, pending_admin, pending_contract_manager, protocol_fee_bps, template_count, vault_app` |
| MW vault (3656084807) | `admin, factory, fee_collector, pending_admin, pending_fee_collector, pending_staking_manager, staking_manager, vault_version` |

### `CONFIG` (CONST and STBL only)

Packed big-endian `uint64` words:

| word | bytes | meaning |
|---|---|---|
| 0 | 0..8 | asset A id (`0` = ALGO) |
| 1 | 8..16 | asset B id |
| 2 | 16..24 | swap fee, basis points |
| 3 | 24..32 | amplifier — **stableswap only** |

24 bytes for constant-product, 32 for stableswap. The fee is word 2 in both.

> **Trap:** the `A` and `B` keys are **reserve balances, not asset ids**. On the
> ALGO/DEFLY pool `A = 5750498382` (µALGO) and `B = 3191423603833` (DEFLY),
> while `CONFIG` gives the pair as `[0, 470842789]`. The asset ids are only in
> `CONFIG` (or in `asset_a`/`asset_b` for managed weighted pools).

## The algorithm

```
CONSTANTS  ────────────────────────────────────────────────────────────
  CREATOR = {
    CONSTANT_PRODUCT: "E5QGPA7LWVAVUADJFSZ6TLKRT6LYINNNQGQFVCPNTBHJM7I2HRYGSJBEMM",
    STABLESWAP:       "PACTFIIFTBWHD52WFMKTSCDZWFVWZK4ZDSWIZHMROZLYD5PZFA4TLCWP7I",
    MANAGED_WEIGHTED: "H2XDAFUDTEPTN24HNUAZI6RCKQ2KDIIO45U767FEHGSGSEGCWWOK4QEIXM",
  }

authenticatePactPool(appId) ───────────────────────────────────────────

  app ← algod.getApplicationByID(appId)          # 1 call; the ONLY required one
  if not found:                    reject "no such application"

  state   ← map(decodeUTF8(kv.key) → kv.value) over app.params.globalState
  creator ← app.params.creator
  escrow  ← getApplicationAddress(appId)         # local, no network

  # ── STEP 1: classify by global-state SHAPE ──────────────────────────
  # Not by creator (factories share one) and not by VERSION (see notes).

  if state has {asset_a, asset_b, swap_fee_bps, factory, lp_asset}:
      type       ← MANAGED_WEIGHTED
      assetA     ← state.asset_a.uint
      assetB     ← state.asset_b.uint
      feeBps     ← state.swap_fee_bps.uint
      lpAssetId  ← state.lp_asset.uint
      factoryId  ← state.factory.uint
      weightA    ← state.weight_a.uint
      # pool names its own factory; that factory's escrow must be the creator
      if getApplicationAddress(factoryId) ≠ creator:
          reject "factory/creator mismatch"

  else if state has {CONFIG, LTID}:
      cfg ← state.CONFIG.bytes                   # packed big-endian uint64 words
      if len(cfg) < 24:            reject "CONFIG too short"

      type      ← (len(cfg) ≥ 32 and state has INITIAL_A) ? STABLESWAP
                                                          : CONSTANT_PRODUCT
      assetA    ← uint64BE(cfg, word 0)
      assetB    ← uint64BE(cfg, word 1)
      cfgFee    ← uint64BE(cfg, word 2)
      lpAssetId ← state.LTID.uint
      if type is STABLESWAP:  amplifier ← uint64BE(cfg, word 3)

      # two independent fee sources; disagreement means we misread the layout
      feeBps ← state has FEE_BPS ? state.FEE_BPS.uint : cfgFee
      if state has FEE_BPS and cfgFee ≠ feeBps:
          reject "FEE_BPS disagrees with CONFIG"

  else:
      reject "not a pool"

  # ── STEP 2: authenticate ────────────────────────────────────────────
  # Bind creator to the DETECTED type, rather than "creator ∈ set" —
  # otherwise a stableswap-shaped app from the CONST creator would pass.

  if creator ≠ CREATOR[type]:
      reject "untrusted creator"

  # ─────────── everything below here is trusted ───────────

  # ── STEP 3: name the pair ───────────────────────────────────────────
  pair ← null
  if lpAssetId exists:
      lp ← algod.getAssetByID(lpAssetId)                        # +1 call
      if lp.params.creator ≠ escrow:
          reject "LP token not minted by this escrow"
      # CONST/STBL LP names carry the pair; MW's does not
      if lp.params.name matches / PACT LP (Token|TKN)$/:
          pair ← strip that suffix from lp.params.name          # "USDC/goUSD [SI]"

  if pair is null:                                              # MW path
      a ← assetInfo(assetA); b ← assetInfo(assetB)              # +2 calls
      pair ← a.unitName + "/" + b.unitName
      # assetInfo(0) ≡ {unitName:"ALGO"} — asset 0 has no ASA record

  return { ok, appId, escrow, type, creator,
           assetA, assetB, feeBps, feePct: feeBps/100,
           lpAssetId, pair, amplifier?, factoryId?, weightA? }


assetInfo(id) ─→ id == 0 ? {unitName:"ALGO"} : algod.getAssetByID(id)

# If you start from an ADDRESS rather than an app id, resolve it (escreg) and
# then verify locally — no trust in the resolver:
#     assert getApplicationAddress(appId) == address
```

## Why the steps are in that order

**Classify before authenticating.** The CONST factory (`1072843805`) is created
by `PACTFIIFTBWH…`, which *is* on the whitelist. A creator-only check accepts it
as a pool. The shape check rejects it: no `CONFIG`, no `asset_a`.

**Bind creator to the detected type**, not to a set. `creator ∈ {the three}` is
weaker, because `PACTFIIFTBWH…` deployed both the stableswap pools and the
constant-product factory, so set membership blurs the two roles.

**Read the LP name only after authenticating.** The name is the spoofable part.
Once `creator` is verified *and* the LP asset was minted by this app's own
escrow, the name is exactly as trustworthy as the app itself.

**The escrow/app-id mapping needs no trust.** An app escrow *is*
`getApplicationAddress(appId)`; verified identical to the address PACT reports
for all three pool types. So a resolver like escreg is a convenience, not a
trusted party — always re-derive and compare.

### Two things that look useful and are not

**`VERSION`** — on chain it reads `201` for constant-product but **`2`** for
stableswap, while PACT's API calls both `201`. It does not discriminate type and
it does not mean what the API's `version` field means. Managed weighted pools
have no `VERSION` key at all.

**Approval program hash** — there is no golden hash to pin:

| kind | distinct approval hashes / pools inspected |
|---|---|
| CONSTANT_PRODUCT v201 | 3 / 40 |
| CONSTANT_PRODUCT v100 | 1 / 10 |
| STABLESWAP | **25 / 40** |
| MANAGED_WEIGHTED | 1 / 40 |
| legacy | 47 / 50 |

Managed weighted pools alone are uniform enough for hash pinning; the others
are clearly templated per instance.

## Validation

The algorithm above was implemented verbatim and run against mainnet.

```
CONST 40, STBL 40, MANAGED_WEIGHTED 40
authenticated + extracted correctly: 120, wrong: 0     (type, both asset ids, fee)
```

Correctness was judged against PACT's own `pool_type`, `primary_asset.id`,
`secondary_asset.id` and `fee_bps`.

Negative cases, all correctly refused:

```
  1072843805  rejected: not a pool (no CONFIG / asset_a)   [CONST factory — whitelisted creator]
  3656084442  rejected: not a pool (no CONFIG / asset_a)   [MW factory]
  3656084807  rejected: not a pool (no CONFIG / asset_a)   [MW vault]
  612810738   rejected: untrusted creator UIGRDPXZR67H…    [legacy pool, arbitrary creator]
  620990689   rejected: untrusted creator FQC2GOU6GMMN…    [legacy pool]
  31566704    rejected: no such application                [an ASA, not an app]
```

Sample output:

```json
{"type":"CONSTANT_PRODUCT","assetA":"0","assetB":"470842789","feeBps":100,"feePct":1,
 "pair":"ALGO/DEFLY","lpAssetId":"1073558659"}
{"type":"STABLESWAP","assetA":"31566704","assetB":"672913181","feeBps":4,"feePct":0.04,
 "pair":"USDC/goUSD [SI]","amplifier":"1000"}
{"type":"MANAGED_WEIGHTED","assetA":"0","assetB":"2994233666","feeBps":36,"feePct":0.36,
 "pair":"ALGO/POW","factoryAppId":"3656084442","weightA":"5000"}
```

## Cost

| type | calls | notes |
|---|---|---|
| CONSTANT_PRODUCT / STABLESWAP | **2** | `getApplicationByID` + `getAssetByID(LTID)` |
| MANAGED_WEIGHTED | **4** | plus two asset lookups for unit names — cache them, pairs repeat heavily |

For flow-algo-surf this is free: `lookupAddress` already calls
`getApplicationByID` to read the fee, and `params.creator` arrives in that same
response. It also *removes* the `lookupAccountCreatedAssets` indexer call, since
`LTID` / `lp_asset` names the LP token directly.

## Test vectors

| type | version | population | app id | pair | fee |
|---|---|---|---|---|---|
| CONSTANT_PRODUCT | v201 | 3814 | `1073547054` | USDC/goBTC | 30 bps |
| CONSTANT_PRODUCT | v201 | ″ | `3642476787` | POW/GAAL | 5 bps |
| CONSTANT_PRODUCT | v100 | 10 | `1072948743` | ALGO/goMINT | 30 bps |
| CONSTANT_PRODUCT | v100 | ″ | `1076447842` | ALGO/USDC | 100 bps |
| STABLESWAP | v201 | 41 | `885102197` | USDC/goUSD | 4 bps |
| STABLESWAP | v201 | ″ | `3334667264` | USDC/7xAlgo | 100 bps |
| MANAGED_WEIGHTED | — | 96 | `3661371688` | ALGO/POW | 36 bps |
| MANAGED_WEIGHTED | — | ″ | `3700138545` | ATARD/CORN | 36 bps |
| legacy (must reject) | — | 100s | `612810738`, `620990689`, `621150092` | — | — |

Fee tiers seen in the wild: 1, 2, 4, 5, 10, 15, 30, 36 and 100 bps.

## Caveats

**The whitelist is a point-in-time snapshot (September 2026).** If PACT deploys
a new factory, its pools stop authenticating until the constant is updated. That
fails *closed* — an unrecognised pool falls back to a generic `App <id>` label
rather than being mislabelled — which is the right direction, but it does mean
the constant needs revisiting when PACT ships a new pool contract.

**Legacy pools are unauthenticable by design.** The ~517 name-matching pools not
created by PACT have 32 distinct creators and 47 distinct approval programs
across 50 inspected, and carry no `ADMIN`/`TREASURY`/`FEE_BPS`. Most are
probably genuine pools from when PACT's deployment was permissionless — but
nothing on chain distinguishes one of those from an asset someone named
`ALGO/USDC PACT LP Token` yesterday. Treat them as unknown.

**`swap_fee_bps` is not the only fee on managed weighted pools.** They also
carry `manager_fee_bps` and `protocol_fee_bps`. `swap_fee_bps` is the one that
matched PACT's reported `fee_bps` on 96/96 pools; the others are splits of it.

## Re-deriving this

The oracle used for checking (never by the algorithm itself):

```sh
curl -s 'https://api.pact.fi/api/pools?limit=100&offset=0' | jq -r \
  '.results[] | [.on_chain_id, .on_chain_address, .pool_type, .version, .fee_bps,
                 .primary_asset.id, .secondary_asset.id, .pool_asset.name] | @tsv'
```

Dump one pool's global state with keys decoded:

```sh
curl -s https://mainnet-api.algonode.cloud/v2/applications/1073558654 \
  | jq -r '.params["global-state"][] | "\(.key|@base64d)\t\(.value)"'
```
