import { Contract, err, uint64 } from "@algorandfoundation/algorand-typescript";

export class AbelStub extends Contract {
  has_asset_label(_asset_id: uint64, _label: string): uint64 {
    err("stub");
  }
}
