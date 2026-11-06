import {
  TemplateVar,
  abimethod,
  Application,
  assert,
  Asset,
  Contract,
  Global,
  log,
  op,
  Txn,
  uint64,
  Account,
  Bytes,
  bytes,
} from "@algorandfoundation/algorand-typescript";
import { AbelStub } from "../abel_stub/contract.algo";
import { Address, baremethod, compileArc4, encodeArc4, Uint32, Uint8 } from "@algorandfoundation/algorand-typescript/arc4";

export type BalanceInfo = {
  balance: uint64;
  minBalance: uint64;
};

// `exists` is false when no asset has the id: destroyed, or not created yet. Its other fields are then empty, which
// a live asset can also be, so they alone can't tell.
export type AssetTinyLabels = {
  exists: boolean;
  name: string;
  unit_name: string;
  decimals: Uint8;
  labels: string[];
};

export type BlockTimeAndTc = {
  ts: Uint32;
  tc: uint64;
};

export type TinymanInfo = {
  validRekey: boolean;
  asset1Id: uint64;
  asset1UnitName: string;
  asset2Id: uint64;
  asset2UnitName: string;
};

export type AssetHolding = {
  optedIn: boolean;
  frozen: boolean;
  balance: uint64;
};

// a Tinyman v2 pool's state, from its escrow's local state in the Tinyman app. `exists` is false for an account that
// is not opted in to the app. `round` is the round the state is as of, and `ts` its block timestamp, which
// time-weighted prices need
export type TinymanPoolState = {
  exists: boolean;
  validRekey: boolean;
  round: uint64;
  ts: uint64;
  asset1Id: uint64;
  asset2Id: uint64;
  asset1Reserves: uint64;
  asset2Reserves: uint64;
  issuedPoolTokens: uint64;
  asset1ProtocolFees: uint64;
  asset2ProtocolFees: uint64;
  totalFeeShare: uint64;
  protocolFeeRatio: uint64;
  cumulativePriceUpdateTimestamp: uint64;
  asset1CumulativePrice: bytes;
  asset2CumulativePrice: bytes;
};

// pool type codes, kept numeric on chain and expanded to names by the SDK
const PACT_TYPE_NONE: uint64 = 0;
const PACT_TYPE_CONSTANT_PRODUCT: uint64 = 1;
const PACT_TYPE_STABLESWAP: uint64 = 2;
const PACT_TYPE_MANAGED_WEIGHTED: uint64 = 3;

export type PactInfo = {
  // PACT_TYPE_*; PACT_TYPE_NONE when the app is not an authenticated PACT pool
  type: Uint8;
  asset1Id: uint64;
  asset1UnitName: string;
  asset2Id: uint64;
  asset2UnitName: string;
  feeBps: uint64;
};

export class AbelReader extends Contract {
  @baremethod({ allowActions: ["UpdateApplication", "DeleteApplication"] })
  adminOnly(): void {
    assert(TemplateVar<uint64>("UPDATABLE") === 1 && Txn.sender === Global.creatorAddress);
  }

  /**
   * Algo balance and minimum balance of each account, in argument order. An app arg holds at most 4,096 bytes (127
   * addresses), so the accounts can be spread over four arrays to fill an app call; empty ones are skipped.
   * Chunked by ghostkit: `@ghostkit-chunk accounts`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getBalanceInfo(accounts: Account[], accounts2: Account[], accounts3: Account[], accounts4: Account[]): BalanceInfo {
    this.logBalanceInfos(accounts);
    this.logBalanceInfos(accounts2);
    this.logBalanceInfos(accounts3);
    this.logBalanceInfos(accounts4);
    return this.getEmptyBalanceInfo();
  }

  private logBalanceInfos(accounts: Account[]): void {
    for (let idx: uint64 = 0; idx < accounts.length; idx++) {
      const account = accounts[idx];
      const balance = op.balance(account);
      if (balance > 0) {
        const minBalance = op.minBalance(account);
        const balanceInfo: BalanceInfo = { balance, minBalance };
        log(encodeArc4(balanceInfo));
      } else {
        log(encodeArc4(this.getEmptyBalanceInfo()));
      }
    }
  }

  private getEmptyBalanceInfo(): BalanceInfo {
    return { balance: 0, minBalance: 0 };
  }

  /**
   * Whether each asset exists, its name, unit name and decimals, and whether the Abel registry labels it `pv` (no labels
   * where the registry doesn't exist, e.g. at a round before it was created). Each existing asset makes one inner app
   * call to the registry, and a group can make at most 256 inner transactions. 128 per app call and per
   * group is among the fastest packings on MainNet (see the abel-assets demo). The assets can be spread over four
   * arrays, logged in argument order; empty ones are skipped.
   * Chunked by ghostkit: `@ghostkit-chunk assetIds refsPerItem=2 maxPerTxn=128 maxPerGroup=128`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getAssetsTiny(assetIds: Asset[], abelAppId: uint64, assetIds2: Asset[], assetIds3: Asset[], assetIds4: Asset[]): AssetTinyLabels {
    // A read at a round before the registry was created would fail calling it: no labels then instead.
    const registryAppId: uint64 = abelAppId !== 0 && op.AppParams.appCreator(abelAppId)[1] ? abelAppId : 0;
    this.logAssetsTiny(assetIds, registryAppId);
    this.logAssetsTiny(assetIds2, registryAppId);
    this.logAssetsTiny(assetIds3, registryAppId);
    this.logAssetsTiny(assetIds4, registryAppId);
    return this.getEmptyAssetTinyLabels();
  }

  private logAssetsTiny(assetIds: Asset[], abelAppId: uint64): void {
    for (let idx: uint64 = 0; idx < assetIds.length; idx++) {
      const asset = assetIds[idx];
      const [_, exists] = op.AssetParams.assetCreator(asset.id);
      if (!exists) {
        log(encodeArc4(this.getEmptyAssetTinyLabels()));
      } else {
        const pv: uint64 =
          abelAppId !== 0 ? compileArc4(AbelStub).call.has_asset_label({ appId: abelAppId, args: [asset.id, "pv"] }).returnValue : 0;
        const assetInfo: AssetTinyLabels = {
          exists: true,
          name: asset.name.toString(),
          unit_name: asset.unitName.toString(),
          decimals: new Uint8(asset.decimals),
          labels: pv === 0 ? ([] as string[]) : ["pv"],
        };
        log(encodeArc4(assetInfo));
      }
    }
  }

  @abimethod({ readonly: true, onCreate: "allow", name: "get_asset_labels", resourceEncoding: "index" })
  getAssetLabels(assetId: Asset): string[] {
    // this stub will be used against abel registry contract instead of this
    return [] as string[];
  }

  private getEmptyAssetTinyLabels(): AssetTinyLabels {
    return {
      exists: false,
      name: "",
      unit_name: "",
      decimals: new Uint8(0),
      labels: [],
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  public getBlockTimesAndTc(firstRound: uint64, lastRound: uint64): BlockTimeAndTc {
    for (let round: uint64 = firstRound; round <= lastRound; round++) {
      const blkData: BlockTimeAndTc = {
        ts: new Uint32(op.Block.blkTimestamp(round)),
        tc: op.Block.blkTxnCounter(round),
      };
      log(encodeArc4(blkData));
    }
    return { ts: new Uint32(0), tc: 0 };
  }

  /**
   * Timestamp and transaction counter of the `span` blocks before the current one, oldest first. Relative to the
   * current round, so the same call reads the latest blocks at any round it is simulated at.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  public getRecentBlockTimesAndTc(span: uint64): BlockTimeAndTc {
    // the block opcode reads up to the block before FirstValid, which is the current round when valid in one round only
    const lastRound: uint64 = Global.round - 1;
    return this.getBlockTimesAndTc(lastRound - span + 1, lastRound);
  }

  /**
   * The auth (rekeyed-to) address of each account, or the zero address.
   * Chunked by ghostkit: `@ghostkit-chunk accounts`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  public getAuthAddrs(accounts: Account[]): Account {
    for (let idx: uint64 = 0; idx < accounts.length; idx++) {
      const [authAddr, _] = op.AcctParams.acctAuthAddr(accounts[idx]);
      // logs the rekeyed-to (auth) address, or the zero address when not rekeyed
      log(authAddr.bytes);
    }
    return Global.zeroAddress;
  }

  /**
   * One asset's holding in each of many accounts. asset_holding_get flags an account that is not opted in, or does not
   * exist, instead of failing, so no account can abort the batch.
   * Chunked by ghostkit: `@ghostkit-chunk accounts`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  public getAssetHoldings(assetId: uint64, accounts: Account[]): AssetHolding {
    // ids below 256 cannot be unnamed resources (see getPactPoolInfo), and touching one would abort the batch
    const readable = assetId >= 256;
    for (const account of accounts) {
      if (readable) {
        const [balance, optedIn] = op.AssetHolding.assetBalance(account, assetId);
        const [frozen, _] = op.AssetHolding.assetFrozen(account, assetId);
        log(encodeArc4({ optedIn, frozen, balance } as AssetHolding));
      } else log(encodeArc4(getEmptyAssetHolding()));
    }
    return getEmptyAssetHolding();
  }

  /**
   * The pair of each Tinyman v2 pool escrow, and whether it is rekeyed to the Tinyman app.
   * Chunked by ghostkit: `@ghostkit-chunk lpEscrows refsPerItem=3`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  public getTinymanInfo(tinymanAppId: Application, lpEscrows: Account[]): TinymanInfo {
    const tinymanEscrow = tinymanAppId.address;
    for (const lpEscrow of lpEscrows) {
      // op forms instead of puya native access, which assert existence
      const [authAddr, _] = op.AcctParams.acctAuthAddr(lpEscrow);
      const validRekey = authAddr === tinymanEscrow;
      // app_local_get_ex errors outright on an account that is not opted in, which would abort
      // the whole batch, so anything that is not a pool escrow has to be skipped here
      if (op.appOptedIn(lpEscrow, tinymanAppId)) {
        const [asset1Id, asset1Exists] = op.AppLocal.getExUint64(lpEscrow, tinymanAppId, Bytes`asset_1_id`);
        const [asset2Id, asset2Exists] = op.AppLocal.getExUint64(lpEscrow, tinymanAppId, Bytes`asset_2_id`);
        log(
          encodeArc4({
            validRekey,
            asset1Id,
            asset1UnitName: asset1Exists ? getAssetUnitName(asset1Id) : "",
            asset2Id,
            asset2UnitName: asset2Exists ? getAssetUnitName(asset2Id) : "",
          } as TinymanInfo),
        );
      } else log(encodeArc4(getEmptyTinymanInfo()));
    }
    return getEmptyTinymanInfo();
  }

  /**
   * The state of each Tinyman v2 pool: reserves, issued pool tokens, protocol fees and cumulative prices, read from the
   * escrow's local state. Only the Tinyman app writes that state, so its types are known; an escrow that is not opted
   * in logs `exists: false`.
   * Chunked by ghostkit: `@ghostkit-chunk lpEscrows`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  public getTinymanPoolStates(tinymanAppId: Application, lpEscrows: Account[]): TinymanPoolState {
    const tinymanEscrow = tinymanAppId.address;
    for (const lpEscrow of lpEscrows) {
      // app_local_get_ex errors on an account that is not opted in, which would abort the whole batch
      if (op.appOptedIn(lpEscrow, tinymanAppId)) {
        const [authAddr, _] = op.AcctParams.acctAuthAddr(lpEscrow);
        const state: TinymanPoolState = {
          exists: true,
          validRekey: authAddr === tinymanEscrow,
          // the program runs in the block after the state it reads
          round: Global.round - 1,
          ts: Global.latestTimestamp,
          asset1Id: localUint(lpEscrow, tinymanAppId, Bytes`asset_1_id`),
          asset2Id: localUint(lpEscrow, tinymanAppId, Bytes`asset_2_id`),
          asset1Reserves: localUint(lpEscrow, tinymanAppId, Bytes`asset_1_reserves`),
          asset2Reserves: localUint(lpEscrow, tinymanAppId, Bytes`asset_2_reserves`),
          issuedPoolTokens: localUint(lpEscrow, tinymanAppId, Bytes`issued_pool_tokens`),
          asset1ProtocolFees: localUint(lpEscrow, tinymanAppId, Bytes`asset_1_protocol_fees`),
          asset2ProtocolFees: localUint(lpEscrow, tinymanAppId, Bytes`asset_2_protocol_fees`),
          totalFeeShare: localUint(lpEscrow, tinymanAppId, Bytes`total_fee_share`),
          protocolFeeRatio: localUint(lpEscrow, tinymanAppId, Bytes`protocol_fee_ratio`),
          cumulativePriceUpdateTimestamp: localUint(lpEscrow, tinymanAppId, Bytes`cumulative_price_update_timestamp`),
          asset1CumulativePrice: localBytes(lpEscrow, tinymanAppId, Bytes`asset_1_cumulative_price`),
          asset2CumulativePrice: localBytes(lpEscrow, tinymanAppId, Bytes`asset_2_cumulative_price`),
        };
        log(encodeArc4(state));
      } else log(encodeArc4(getEmptyTinymanPoolState()));
    }
    return getEmptyTinymanPoolState();
  }

  // the three creators are network specific, so they are arguments rather than constants; the SDK
  // fills in the mainnet ones. they are arc4 addresses, not Account references, so they cost app
  // arg bytes instead of eating into the group's resource references
  /**
   * Type, pair and fee of each PACT pool app, or type 0 for an app that is not an authenticated PACT pool.
   * Chunked by ghostkit: `@ghostkit-chunk pactAppIds refsPerItem=3`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  public getPactInfo(
    constantProductCreator: Address,
    stableswapCreator: Address,
    managedWeightedCreator: Address,
    pactAppIds: Application[],
  ): PactInfo {
    for (const pactAppId of pactAppIds) {
      log(
        encodeArc4(
          getPactPoolInfo(
            pactAppId,
            constantProductCreator.native,
            stableswapCreator.native,
            managedWeightedCreator.native,
          ),
        ),
      );
    }
    return getEmptyPactInfo();
  }
}

function getEmptyAssetHolding(): AssetHolding {
  return { optedIn: false, frozen: false, balance: 0 };
}

function getEmptyTinymanPoolState(): TinymanPoolState {
  return {
    exists: false,
    validRekey: false,
    round: 0,
    ts: 0,
    asset1Id: 0,
    asset2Id: 0,
    asset1Reserves: 0,
    asset2Reserves: 0,
    issuedPoolTokens: 0,
    asset1ProtocolFees: 0,
    asset2ProtocolFees: 0,
    totalFeeShare: 0,
    protocolFeeRatio: 0,
    cumulativePriceUpdateTimestamp: 0,
    asset1CumulativePrice: Bytes``,
    asset2CumulativePrice: Bytes``,
  };
}

// a uint64 from the Tinyman app's local state, or 0 if the key is missing
function localUint(account: Account, app: Application, key: bytes): uint64 {
  const [value, exists] = op.AppLocal.getExUint64(account, app, key);
  return exists ? value : 0;
}

// a byte string from the Tinyman app's local state, or empty if the key is missing
function localBytes(account: Account, app: Application, key: bytes): bytes {
  const [value, exists] = op.AppLocal.getExBytes(account, app, key);
  return exists ? value : Bytes``;
}

function getEmptyTinymanInfo(): TinymanInfo {
  return {
    validRekey: false,
    asset1Id: 0,
    asset1UnitName: "",
    asset2Id: 0,
    asset2UnitName: "",
  };
}

function getEmptyPactInfo(): PactInfo {
  return {
    type: new Uint8(PACT_TYPE_NONE),
    asset1Id: 0,
    asset1UnitName: "",
    asset2Id: 0,
    asset2UnitName: "",
    feeBps: 0,
  };
}

function getPactPoolInfo(
  app: Application,
  constantProductCreator: Account,
  stableswapCreator: Account,
  managedWeightedCreator: Account,
): PactInfo {
  // simulate will not add an app id below 256 as an unnamed resource -- those are ambiguous with
  // indexes into the foreign apps array -- and touching an unavailable app aborts the whole batch.
  // id 0 is worse still: to the AVM it means the app currently executing. no creatable on any
  // network has an id that low, so refuse them before reading anything
  if (app.id < 256) return getEmptyPactInfo();

  // op form: app_params_get flags a missing app instead of asserting the way Application.creator
  // would, so an app id that never existed or has been deleted cannot abort the whole batch
  const [creator, appExists] = op.AppParams.appCreator(app);
  if (!appExists) return getEmptyPactInfo();

  // one expected creator per pool type. passing the zero address for a type disables it, since no
  // app can have been created by it
  const isConstProduct = creator === constantProductCreator;
  const isStableswapCreator = creator === stableswapCreator;
  const isManagedWeighted = creator === managedWeightedCreator;
  // gate on the creator SET before reading any global state. app_global_get_ex pushes a value with
  // the type it was stored as and nothing casts it, so an app that stores CONFIG as a uint64 would
  // panic `len` and take the whole batch down with it. only PACT can create an app with one of
  // these creators, so past this point the state is PACT's own and known-shaped. this does not
  // widen what is accepted -- the type is still bound to a single creator below
  if (!isConstProduct && !isStableswapCreator && !isManagedWeighted) return getEmptyPactInfo();

  // classify by global state SHAPE before authenticating: the creators do not discriminate on
  // their own, since the stableswap deployer also created the constant product factory, and that
  // factory would otherwise pass as one of its own pools

  // managed weighted pools keep the pair and the swap fee in plain keys
  const [swapFeeBps, hasSwapFeeBps] = op.AppGlobal.getExUint64(app, Bytes`swap_fee_bps`);
  const [assetA, hasAssetA] = op.AppGlobal.getExUint64(app, Bytes`asset_a`);
  const [assetB, hasAssetB] = op.AppGlobal.getExUint64(app, Bytes`asset_b`);
  if (hasSwapFeeBps && hasAssetA && hasAssetB) {
    // the pool's own `factory` key is not cross-checked: the factory's escrow *is* this creator,
    // so it would be a weaker restatement of the check below, at the cost of one app reference.
    // manager_fee_bps and protocol_fee_bps are splits of swap_fee_bps, which is the swap fee
    if (!isManagedWeighted) return getEmptyPactInfo();
    return {
      type: new Uint8(PACT_TYPE_MANAGED_WEIGHTED),
      asset1Id: assetA,
      asset1UnitName: getAssetUnitName(assetA),
      asset2Id: assetB,
      asset2UnitName: getAssetUnitName(assetB),
      feeBps: swapFeeBps,
    };
  }

  // constant product and stableswap pack the pair, the fee and (stableswap only) the amplifier
  // into CONFIG as big-endian uint64 words. the A and B keys are reserve balances, not asset ids
  const [config, hasConfig] = op.AppGlobal.getExBytes(app, Bytes`CONFIG`);
  const [_ltid, hasLtid] = op.AppGlobal.getExUint64(app, Bytes`LTID`);
  if (!hasConfig || !hasLtid || config.length < 24) return getEmptyPactInfo();

  // 24 bytes for constant product, 32 for stableswap -- but VERSION discriminates neither, so the
  // amplifier keys have to corroborate the length
  const [_initialA, hasInitialA] = op.AppGlobal.getExUint64(app, Bytes`INITIAL_A`);
  const isStableswap = config.length >= 32 && hasInitialA;

  // bind the creator to the DETECTED type rather than to the set of three: the stableswap deployer
  // also created the constant product factory, so set membership blurs the two roles
  if (isStableswap ? !isStableswapCreator : !isConstProduct) return getEmptyPactInfo();

  // two independent fee sources; disagreement means the CONFIG layout was misread. in practice
  // every authenticated pool carries FEE_BPS -- the shape without it is the legacy pool, which the
  // creator check has already refused -- but the doc's fallback is kept
  const configFeeBps = op.extractUint64(config, 16);
  const [feeBps, hasFeeBps] = op.AppGlobal.getExUint64(app, Bytes`FEE_BPS`);
  if (hasFeeBps && feeBps !== configFeeBps) return getEmptyPactInfo();

  const asset1Id = op.extractUint64(config, 0);
  const asset2Id = op.extractUint64(config, 8);
  return {
    type: new Uint8(isStableswap ? PACT_TYPE_STABLESWAP : PACT_TYPE_CONSTANT_PRODUCT),
    asset1Id,
    // asset id 0 is ALGO and is the *primary* asset on PACT, unlike tinyman where it is asset 2
    asset1UnitName: getAssetUnitName(asset1Id),
    asset2Id,
    asset2UnitName: getAssetUnitName(asset2Id),
    feeBps: hasFeeBps ? feeBps : configFeeBps,
  };
}

function getAssetUnitName(assetId: uint64): string {
  // tinyman uses asset id 0 for ALGO, which has no asset params to read
  if (assetId === 0) return "ALGO";
  // asset_params_get pushes a uint64 0 (not bytes) when the asset is gone, so the exists
  // flag has to be honoured -- otherwise a deleted asset fails the encode below on `len`
  const [unitName, exists] = op.AssetParams.assetUnitName(assetId);
  return exists ? unitName.toString() : "";
}
