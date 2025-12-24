import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AbelReaderFactory } from "../artifacts/abel_reader/AbelReaderClient";

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log("=== Deploying AbelReader ===");

  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");

  const factory = algorand.client.getTypedAppFactory(AbelReaderFactory, {
    defaultSender: deployer.addr,
  });

  await factory.deploy({
    onUpdate: "update",
    onSchemaBreak: "fail",
    updatable: true,
    createParams: { method: "getAssetsTiny", args: { abelAppId: 0n, assetIds: [] } },
  });
}
