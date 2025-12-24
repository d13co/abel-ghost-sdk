import { Asset, Contract, err, uint64 } from "@algorandfoundation/algorand-typescript";

export class AbelStub extends Contract {
  has_asset_label(_asset_id: uint64, _label: string): uint64 {
    err("stub");
  }

  get_asset_labels(_asset_id: Asset): string[] {
    err("stub");
  }
}
