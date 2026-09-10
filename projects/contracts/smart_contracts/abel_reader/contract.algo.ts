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

function getAssetUnitName(assetId: uint64): string {
  // tinyman uses asset id 0 for ALGO, which has no asset params to read
  if (assetId === 0) return "ALGO";
  // asset_params_get pushes a uint64 0 (not bytes) when the asset is gone, so the exists
  // flag has to be honoured -- otherwise a deleted asset fails the encode below on `len`
  const [unitName, exists] = op.AssetParams.assetUnitName(assetId);
  return exists ? unitName.toString() : "";
}
