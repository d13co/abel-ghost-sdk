import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import {
  ghostkitDetectNode,
  ghostkitDTBackend,
  ghostkitStockBackend,
  type GhostkitBackend,
  type GhostkitGroupOutcome,
} from "./generated/AbelReaderSDK.js"

/**
 * algosdk's ABI decoder reads a dynamic tuple through `new DataView(bytes.buffer)`, ignoring `byteOffset`, so it
 * misreads any log that is a view into a larger buffer. The logs of an extended (dtalgorand) simulate are such views
 * into the decoded response. A copy starts at offset 0, so every log is copied before ghostkit decodes it.
 */
function copyLogs(outcome: GhostkitGroupOutcome): GhostkitGroupOutcome {
  return outcome.ok ? { ...outcome, logs: outcome.logs.map((txnLogs) => txnLogs.map((log) => log.slice())) } : outcome
}

/** Wraps a backend so the logs it returns decode correctly (see `copyLogs`) */
export function withCopiedLogs(backend: GhostkitBackend): GhostkitBackend {
  return {
    name: backend.name,
    limits: backend.limits,
    simulate: async (groups, options) => (await backend.simulate(groups, options)).map(copyLogs),
    simulateRounds: async (groups, rounds, options) =>
      (await backend.simulateRounds(groups, rounds, options)).map((round) => ({ ...round, groups: round.groups.map(copyLogs) })),
  }
}

/** The backend ghostkit would pick for `mode`, with copied logs */
export async function resolveBackend(
  algorand: AlgorandClient,
  mode: "auto" | "dt" | "stock" | GhostkitBackend,
  debug = false,
): Promise<GhostkitBackend> {
  if (typeof mode === "object") return withCopiedLogs(mode)
  if (mode === "stock") return withCopiedLogs(ghostkitStockBackend(algorand))
  const node = await ghostkitDetectNode(algorand)
  if (node.kind === "dt") return withCopiedLogs(ghostkitDTBackend(algorand, node.limits))
  if (mode === "dt") throw new Error(`backend 'dt' can't be used: ${node.reason}`)
  if (debug) console.warn(`abel-ghost-sdk: using one simulate per group, since ${node.reason}`)
  return withCopiedLogs(ghostkitStockBackend(algorand))
}
