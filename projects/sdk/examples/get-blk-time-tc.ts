import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { AbelGhostSDK } from "../src/index.js"

const algorand = AlgorandClient.mainNet()

const sdk = new AbelGhostSDK({
  algorand,
  registryAppId: 2914159523,
})

const delta = process.argv[2] ? BigInt(process.argv[2]) : BigInt(0)

;(async () => {
  let { lastRound } = await algorand.client.algod.status().do();
  lastRound += delta
  const firstRound = lastRound - BigInt(1000)

  console.time("fetch");
  const data = await sdk.getBlockTimesAndTc(firstRound, lastRound);
  console.timeEnd("fetch");

  const [first, last] = [data[0], data[data.length - 1]];
  console.log({ first, last });

  const { block: { header: {  timestamp: ts1, txnCounter: tc1 }  }  } = await algorand.client.algod.block(firstRound).headerOnly(true).do();
  const { block: { header: {  timestamp: ts2, txnCounter: tc2 }  }  } = await algorand.client.algod.block(lastRound).headerOnly(true).do();

  console.log({ firstTcMatch: tc1 === first.tc, firstTsMatch: Number(ts1) === first.ts, lastTcMatch: tc2 === last.tc, lastTsMatch: Number(ts2) === last.ts, delta: last.rnd - first.rnd });
})()
