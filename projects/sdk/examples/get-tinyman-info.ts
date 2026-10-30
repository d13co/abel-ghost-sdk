import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { getApplicationAddress } from "algosdk"
import { AbelGhostSDK, MAINNET_TINYMAN_V2_APP_ID } from "../src/index.js"

const algorand = AlgorandClient.mainNet()

const sdk = new AbelGhostSDK({
  algorand,
  ghostAppId: 3381542955n,
  debug: true,
})

// Pool escrows are rekeyed to the Tinyman v2 app account, so the indexer can list them.
// When no escrows are passed on the command line, we pull a batch and verify the contract
// agrees that every one of them is a valid, rekeyed pool escrow.
const TINYMAN_APP_ADDR = getApplicationAddress(MAINNET_TINYMAN_V2_APP_ID).toString()
const INDEXER_URL = `https://mainnet-idx.4160.nodely.dev/v2/accounts?auth-addr=${TINYMAN_APP_ADDR}&limit=420`

;(async () => {
  let escrows = process.argv.slice(2)
  let expectPools = false

  if (escrows.length === 0) {
    const res = await fetch(INDEXER_URL)
    if (!res.ok) throw new Error(`indexer request failed: ${res.status} ${res.statusText}`)
    const { accounts } = (await res.json()) as { accounts: { address: string }[] }
    escrows = accounts.map((a) => a.address)
    expectPools = true
    console.log(`Fetched ${escrows.length} accounts rekeyed to ${TINYMAN_APP_ADDR} from indexer`)
  }

  console.time("fetch")
  const data = await sdk.getTinymanInfo(escrows, MAINNET_TINYMAN_V2_APP_ID)
  console.timeEnd("fetch")

  for (const [address, info] of data) {
    console.log(
      `${address} rekey=${info.validRekey ? "ok " : "BAD"} ` +
        `${info.asset1UnitName}(${info.asset1Id})-${info.asset2UnitName}(${info.asset2Id})`,
    )
  }

  const values = [...data.values()]
  const pools = values.filter((i) => i.asset1Id !== 0n)
  const badRekey = values.filter((i) => !i.validRekey)
  console.log({ total: data.size, pools: pools.length, notRekeyedToTinyman: badRekey.length })

  if (expectPools) {
    // every account the indexer returned is rekeyed to the tinyman app, so all of them
    // must come back as valid pool escrows with a real asset 1
    const allPools = values.length > 0 && pools.length === values.length && badRekey.length === 0
    console.log({ allPools })
    if (!allPools) {
      console.error("MISMATCH: not every rekeyed account resolved to a valid tinyman pool")
      process.exit(1)
    }
  }
})()
