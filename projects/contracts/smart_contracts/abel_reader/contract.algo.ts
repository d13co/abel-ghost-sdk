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
} from "@algorandfoundation/algorand-typescript";
import { AbelStub } from "../abel_stub/contract.algo";
import { baremethod, compileArc4, encodeArc4, Uint32, Uint8 } from "@algorandfoundation/algorand-typescript/arc4";

export type BalanceInfo = {
  balance: uint64;
  minBalance: uint64;
};

export type AssetTinyLabels = {
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

  @abimethod({ readonly: true, onCreate: "allow" })
  getBalanceInfo(accounts: Account[]): BalanceInfo {
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
    return this.getEmptyBalanceInfo();
  }

  private getEmptyBalanceInfo(): BalanceInfo {
    return { balance: 0, minBalance: 0 };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getAssetsTiny(assetIds: Asset[], abelAppId: uint64): AssetTinyLabels {
    for (let idx: uint64 = 0; idx < assetIds.length; idx++) {
      const asset = assetIds[idx];
      const [_, exists] = op.AssetParams.assetCreator(asset.id);
      if (!exists) {
        log(encodeArc4(this.getEmptyAssetTinyLabels()));
      } else {
        const pv: uint64 =
          abelAppId !== 0 ? compileArc4(AbelStub).call.has_asset_label({ appId: abelAppId, args: [asset.id, "pv"] }).returnValue : 0;
        const assetInfo: AssetTinyLabels = {
          name: asset.name.toString(),
          unit_name: asset.unitName.toString(),
          decimals: new Uint8(asset.decimals),
          labels: pv === 0 ? ([] as string[]) : ["pv"],
        };
        log(encodeArc4(assetInfo));
      }
    }
    return this.getEmptyAssetTinyLabels();
  }

  @abimethod({ readonly: true, onCreate: "allow", name: "get_asset_labels", resourceEncoding: "index" })
  getAssetLabels(assetId: Asset): string[] {
    // this stub will be used against abel registry contract instead of this
    return [] as string[];
  }

  private getEmptyAssetTinyLabels(): AssetTinyLabels {
    return {
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

  @abimethod({ readonly: true, onCreate: "allow" })
  public getAuthAddrs(accounts: Account[]): Account {
    for (let idx: uint64 = 0; idx < accounts.length; idx++) {
      const [authAddr, _] = op.AcctParams.acctAuthAddr(accounts[idx]);
      // logs the rekeyed-to (auth) address, or the zero address when not rekeyed
      log(authAddr.bytes);
    }
    return Global.zeroAddress;
  }

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

  @abimethod({ readonly: true, onCreate: "allow" })
  public getPactInfo(pactAppIds: Application[]): PactInfo {
    for (const pactAppId of pactAppIds) {
      log(encodeArc4(getPactPoolInfo(pactAppId)));
    }
    return getEmptyPactInfo();
  }
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

function getPactPoolInfo(app: Application): PactInfo {
  // op form: app_params_get flags a missing app instead of asserting the way Application.creator
  // would, so an app id that never existed or has been deleted cannot abort the whole batch
  const [creator, appExists] = op.AppParams.appCreator(app);
  if (!appExists) return getEmptyPactInfo();

  // one creator per pool type; mainnet values. future version could change these to arguments to support other networks
  const constProductCreator = creator === Account("E5QGPA7LWVAVUADJFSZ6TLKRT6LYINNNQGQFVCPNTBHJM7I2HRYGSJBEMM");
  const stableswapCreator = creator === Account("PACTFIIFTBWHD52WFMKTSCDZWFVWZK4ZDSWIZHMROZLYD5PZFA4TLCWP7I");
  const managedWeightedCreator = creator === Account("H2XDAFUDTEPTN24HNUAZI6RCKQ2KDIIO45U767FEHGSGSEGCWWOK4QEIXM");
  // gate on the creator SET before reading any global state. app_global_get_ex pushes a value with
  // the type it was stored as and nothing casts it, so an app that stores CONFIG as a uint64 would
  // panic `len` and take the whole batch down with it. only PACT can create an app with one of
  // these creators, so past this point the state is PACT's own and known-shaped. this does not
  // widen what is accepted -- the type is still bound to a single creator below
  if (!constProductCreator && !stableswapCreator && !managedWeightedCreator) return getEmptyPactInfo();

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
    if (!managedWeightedCreator) return getEmptyPactInfo();
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
  if (isStableswap ? !stableswapCreator : !constProductCreator) return getEmptyPactInfo();

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
