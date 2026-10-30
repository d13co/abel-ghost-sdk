import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK } from "../src/index.js"

const algorand = AlgorandClient.mainNet()

const sdk = new AbelGhostSDK({
  algorand,
  debug: true,
})

// Known mainnet auth address that many accounts are rekeyed to.
// When no accounts are passed on the command line, we pull up to 1000 accounts
// rekeyed to this address from the indexer and verify the contract agrees.
const KNOWN_AUTH_ADDR = "XSKED5VKZZCSYNDWXZJI65JM2HP7HZFJWCOBIMOONKHTK5UVKENBNVDEYM"
const INDEXER_URL = `https://mainnet-idx.4160.nodely.dev/v2/accounts?auth-addr=${KNOWN_AUTH_ADDR}&limit=1000`

;(async () => {
  let accounts = process.argv.slice(2)
  if (accounts.length === 0) {
    const res = await fetch(INDEXER_URL)
    if (!res.ok) throw new Error(`indexer request failed: ${res.status} ${res.statusText}`)
    const { accounts: idxAccounts } = (await res.json()) as { accounts: { address: string }[] }
    accounts = idxAccounts.map((a) => a.address)
    console.log(`Fetched ${accounts.length} accounts rekeyed to ${KNOWN_AUTH_ADDR} from indexer`)
  }

  console.time("fetch")
  const data = await sdk.getBalanceInfo(accounts)
  console.timeEnd("fetch")

  console.log(data)
})()
