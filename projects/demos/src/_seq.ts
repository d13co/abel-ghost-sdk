import { makeSDK, safeTip, spread } from "./lib/node.js"
;(async () => {
  const sdk = makeSDK({ registry: false })
  const tip = await safeTip()
  const rounds = spread(1001n, tip, 1024)
  const parts = Array.from({ length: 4 }, (_, k) => rounds.filter((_, i) => i % 4 === k))
  await sdk.getBalanceInfo(["737777777777777777777777777777777777777777777777777UFEJ2CI"])
  const start = performance.now()
  for (const [k, part] of parts.entries()) {
    const s = performance.now()
    await sdk.getBlockTimesAndTcAtRounds(part, 1000)
    console.log(`sequential request ${k + 1}: ${Math.round(performance.now() - s)} ms`)
  }
  console.log(`sequential total: ${Math.round(performance.now() - start)} ms`)
  const s2 = performance.now()
  await Promise.all(parts.slice(0, 2).map((part) => sdk.getBlockTimesAndTcAtRounds(part, 1000)))
  console.log(`2 in parallel: ${Math.round(performance.now() - s2)} ms`)
  const s4 = performance.now()
  await Promise.all(parts.map((part) => sdk.getBlockTimesAndTcAtRounds(part, 1000)))
  console.log(`4 in parallel: ${Math.round(performance.now() - s4)} ms`)
})()
