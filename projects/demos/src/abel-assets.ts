// The Abel asset label registry on MainNet: every labelled asset read through the reader contract, the best way to
// pack that read, and the registry's history.
//
//   pnpm abel [--reps 5]
//
// - Every asset in the registry (its boxes) through `getAssetsTiny`, which reads each asset's params and asks the
//   registry, with an inner app call, whether it carries the `pv` label.
// - A packing sweep: assets per app call, each timed `--reps` times. A query runs every app call alone in its group,
//   so the inner app calls bound an app call to 256 assets, and how app calls would be grouped makes no difference.
// - The same labels straight from the registry's boxes, in one `include=values` request, as a baseline.
// - The registry's history from `/v2/applications/{id}/boxes/versions`: when each asset got its labels.
import { MAINNET_ABEL_REGISTRY_APP_ID, type AbelLabelChange, type GhostkitChunkOptions } from "abel-ghost-sdk/src/index.js"
import { describe, makeSDK, measure, num, printNode, queries, type Measured } from "./lib/node.js"
import { writeReport, type Point, type Section } from "./lib/report.js"

const PER_TXN = [8, 16, 32, 64, 128, 254]

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

;(async () => {
  const sdk = makeSDK()
  const nodeLine = await printNode(sdk)
  const reps = num("reps", 5)

  // ---- the registry's assets and labels, straight from its boxes
  const ids = await measure(() => sdk.getAllAssetIDs())
  const boxes = await measure(() => sdk.getAllAssetLabels())
  const labels = await sdk.getAbelLabels()
  console.log(`${ids.result.length} assets in registry ${MAINNET_ABEL_REGISTRY_APP_ID}: ${labels.map((l) => `${l.id} (${l.name}) ${l.numAssets}`).join(", ")}`)
  console.log(`  all labels from the boxes, one request: ${describe(boxes)}`)

  // ---- every asset through the reader, default packing
  const read = await measure(() => sdk.getAssetsTinyLabels(ids.result))
  console.log(`  every asset through the reader: ${describe(read)}`)
  const mismatches = ids.result.filter((id) => read.result.get(id)!.labels.includes("pv") !== (boxes.result.get(id) ?? []).includes("pv"))
  console.log(`  pv label, reader vs boxes: ${ids.result.length - mismatches.length}/${ids.result.length} agree`)

  // ---- the packing sweep: a query runs each app call alone, so only the assets per app call matter
  type Cell = { perTxn: number; ms: number | null; requests: number | null; note?: string }
  const sweep: Cell[] = []
  for (const perTxn of PER_TXN) {
    // up to 16 app calls per group, as a group allows; the query sends each alone
    const chunk: GhostkitChunkOptions = { arg: "assetIds", refsPerItem: 2, maxPerTxn: perTxn, maxPerGroup: perTxn * 16 }
    const runs: Measured<unknown>[] = []
    let cell: Cell
    try {
      for (let i = 0; i < reps; i++) runs.push(await measure(() => sdk.getAssetsTinyLabels(ids.result, { chunk })))
      cell = { perTxn, ms: median(runs.map((r) => r.ms)), requests: runs[0].queries }
    } catch (error) {
      const message = (error as Error).message
      cell = { perTxn, ms: null, requests: null, note: message.replace(/^.*?failed[^:]*: /, "").slice(0, 160) }
    }
    sweep.push(cell)
    console.log(`  ${perTxn} per app call: ${cell.ms === null ? `failed: ${cell.note}` : `${cell.ms} ms, ${queries(cell.requests!)}`}`)
  }
  const best = sweep.filter((c) => c.ms !== null).sort((a, b) => a.ms! - b.ms!)[0] ?? { perTxn: 0, ms: NaN, requests: null }
  console.log(`fastest: ${best.perTxn} assets per app call (${best.ms} ms)`)

  // ---- history: labels over time
  const history = await measure(() => sdk.getAbelLabelHistory())
  console.log(`label history: ${history.result.length} changes, ${describe(history)}`)
  const current = new Map<bigint, string[]>()
  const series = new Map<string, Point[]>(labels.map((l) => [l.id, []]))
  for (const change of history.result) {
    current.set(change.assetId, change.deleted ? [] : change.labels)
    const counts = new Map<string, number>(labels.map((l) => [l.id, 0]))
    for (const assetLabels of current.values()) for (const label of assetLabels) counts.set(label, (counts.get(label) ?? 0) + 1)
    for (const [label, count] of counts) series.get(label)?.push([change.timestamp, count])
  }
  // the newest additions, named by the reader
  const newest: AbelLabelChange[] = history.result.filter((c) => !c.deleted).slice(-15).reverse()

  const sections: Section[] = [
    {
      kind: "bar",
      title: "Packing sweep: assets per app call",
      subtitle: `Wall time to read all ${ids.result.length} assets through queries, median of ${reps}. A query runs each app call alone in its group, with the node's per-call opcode budget, so how calls would be grouped makes no difference; what changes is how many app calls the read takes. Asset ids are 8 bytes, so an app call takes up to 254, and each asset's inner app call keeps an app call to 256 assets. The reader's chunk tag uses 128 per app call.${
        sweep.some((c) => c.ms === null) ? ` Failed: ${sweep.filter((c) => c.ms === null).map((c) => `${c.perTxn} per app call (${c.note})`).join("; ")}.` : ""
      }`,
      labels: sweep.map((c) => `${c.perTxn} per app call`),
      yLabel: "median ms",
      horizontal: true,
      series: [{ label: "median ms", values: sweep.map((c) => c.ms), slot: 0 }],
    },
    {
      kind: "line",
      title: "Labelled assets over time",
      subtitle: "Assets carrying each label after every change to the registry, from its box history.",
      x: "time",
      yLabel: "assets",
      zeroY: true,
      series: labels.map((l, i) => ({ label: `${l.id}: ${l.name}`, points: series.get(l.id)!, step: true, slot: i })),
    },
    {
      kind: "table",
      title: "Newest label changes",
      columns: ["date (UTC)", "round", "asset", "name", "labels"],
      rows: newest.map((c) => [
        new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace("T", " "),
        String(c.round),
        String(c.assetId),
        read.result.get(c.assetId)?.name ?? "",
        c.labels.join(", "),
      ]),
    },
    {
      kind: "table",
      title: "Reader vs boxes",
      subtitle: "Two ways to get the registry's labels.",
      columns: ["way", "requests", "wall time (ms)", "gets"],
      rows: [
        ["`getAssetsTinyLabels` (reader contract)", read.queries, read.ms, "name, unit name, decimals and the `pv` label, for any asset ids"],
        ["`getAllAssetLabels` (boxes with values)", boxes.other, boxes.ms, "every label of every registered asset, nothing else"],
      ],
    },
    {
      kind: "text",
      title: "AVM 13",
      paragraphs: [
        "An AVM 13 build of the reader would take up to 16 KB of app args per app call under consensus v42, so far fewer app calls. It isn't applicable on MainNet yet: built with `--target-avm-version 13`, the reader fails the node's program check at every round, the latest included (`check failed on ApprovalProgram: branch target outside of program`), and a single app arg is still capped at 4,096 bytes. The node's developer API, which would allow `protocol: 'future'`, is off.",
      ],
    },
    {
      kind: "text",
      title: "How it was read",
      paragraphs: [
        nodeLine + ".",
        `Asset ids: \`sdk.getAllAssetIDs()\` (${describe(ids)}). Labels from the boxes: \`sdk.getAllAssetLabels()\` (${describe(boxes)}). Reader: \`sdk.getAssetsTinyLabels(ids)\` (${describe(read)}). History: \`sdk.getAbelLabelHistory()\` (${describe(history)}).`,
        `The reader and the boxes agree on the \`pv\` label for ${ids.result.length - mismatches.length} of ${ids.result.length} assets${
          mismatches.length ? ` (differ: ${mismatches.slice(0, 10).join(", ")})` : ""
        }.`,
      ],
    },
  ]
  const path = writeReport("abel-assets", {
    title: "Abel asset labels",
    subtitle: `The ${ids.result.length} assets of the Abel registry (app ${MAINNET_ABEL_REGISTRY_APP_ID}) on MainNet, read from a dtalgorand node.`,
    stats: [
      { label: "Assets", value: ids.result.length.toLocaleString("en-US"), note: labels.map((l) => `${l.id}: ${l.numAssets}`).join(", ") },
      { label: "Reader, default packing", value: `${read.ms} ms`, note: queries(read.queries) },
      { label: "Fastest packing", value: `${best.ms} ms`, note: `${best.perTxn} per app call` },
      { label: "Boxes with values", value: `${boxes.ms} ms`, note: "1 request, labels only" },
      { label: "Label changes", value: history.result.length.toLocaleString("en-US"), note: `${history.versions} /versions requests` },
    ],
    sections,
    data: { sweep, best },
  })
  console.log(`report: ${path}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
