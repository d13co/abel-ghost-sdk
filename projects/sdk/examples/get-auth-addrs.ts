import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK } from "../src/index.js"

const algorand = AlgorandClient.mainNet()

const sdk = new AbelGhostSDK({
  algorand,
})

// Known mainnet auth address that many accounts are rekeyed to.
// When no accounts are passed on the command line, we pull up to 100 accounts
// rekeyed to this address from the indexer and verify the contract agrees.
const KNOWN_AUTH_ADDR = "XSKED5VKZZCSYNDWXZJI65JM2HP7HZFJWCOBIMOONKHTK5UVKENBNVDEYM"
const INDEXER_URL = `https://mainnet-idx.4160.nodely.dev/v2/accounts?auth-addr=${KNOWN_AUTH_ADDR}&limit=100`

;(async () => {
  let accounts = process.argv.slice(2)
  let expectAuthAddr: string | undefined

  if (accounts.length === 0) {
    const res = await fetch(INDEXER_URL)
    if (!res.ok) throw new Error(`indexer request failed: ${res.status} ${res.statusText}`)
    const { accounts: idxAccounts } = (await res.json()) as { accounts: { address: string }[] }
    accounts = idxAccounts.map((a) => a.address)
    expectAuthAddr = KNOWN_AUTH_ADDR
    console.log(`Fetched ${accounts.length} accounts rekeyed to ${KNOWN_AUTH_ADDR} from indexer`)
  }

  console.time("fetch")
  const data = await sdk.getAuthAddrs(accounts)
  console.timeEnd("fetch")

  console.log(data)

  if (expectAuthAddr) {
    const values = [...data.values()]
    const matched = values.filter((a) => a === expectAuthAddr).length
    const allMatch = values.length > 0 && matched === values.length
    console.log({ allMatch, matched, total: data.size })
    if (!allMatch) {
      console.error("MISMATCH: not every account resolved to the expected auth address")
      process.exit(1)
    }
  }
})()
