import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK } from "../src/index.js"

const algorand = AlgorandClient.mainNet()

const sdk = new AbelGhostSDK({
  algorand,
})

;(async () => {
  const data = await sdk.getAssetsTinyLabels([31566704])

  console.log({ data })
})()
