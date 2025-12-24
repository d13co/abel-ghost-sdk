import { TemplateVar, abimethod, Application, assert, Asset, Contract, Global, log, op, Txn, uint64 } from "@algorandfoundation/algorand-typescript";
import { AbelStub } from "../abel_stub/contract.algo";
import { baremethod, compileArc4, encodeArc4, Uint8 } from "@algorandfoundation/algorand-typescript/arc4";

export type AssetTinyLabels = {
  name: string;
  unit_name: string;
  decimals: Uint8;
  labels: string[];
};

export class AbelReader extends Contract {
  @baremethod({ allowActions: ["UpdateApplication", "DeleteApplication"] })
  adminOnly(): void {
    log("1")
    assert(TemplateVar<uint64>("UPDATABLE") === 1 && Txn.sender === Global.creatorAddress);
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getAssetsTiny(assetIds: Asset[], abelAppId: uint64): AssetTinyLabels {
    for (let idx: uint64 = 0; idx < assetIds.length; idx++) {
      const asset = assetIds[idx];
      const [_, exists] = op.AssetParams.assetCreator(asset.id);
      if (!exists) {
        log(encodeArc4(this.getEmptyAssetTinyLabels()));
      } else {
        const pv: uint64 = abelAppId !== 0 ? compileArc4(AbelStub).call.has_asset_label({ appId: abelAppId, args: [asset.id, "pv"] }).returnValue : 0
        const assetInfo: AssetTinyLabels = {
          name: asset.name.toString(),
          unit_name: asset.unitName.toString(),
          decimals: new Uint8(asset.decimals),
          labels: pv === 0 ? [] as string[] : ["pv"],
        };
        log(encodeArc4(assetInfo));
      }
    }
    return this.getEmptyAssetTinyLabels();
  }

  @abimethod({ readonly: true, onCreate: "allow" , name: "get_asset_labels", resourceEncoding: "index" })
  getAssetLabels(assetId: Asset): string[] {
    // this stub will be used against abel registry contract instead of this
    return [] as string[]
  }

  private getEmptyAssetTinyLabels(): AssetTinyLabels {
    return {
      name: "",
      unit_name: "",
      decimals: new Uint8(0),
      labels: [],
    };
  }
}
