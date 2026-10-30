// Writes a demo's results as a self-contained HTML page with charts (Chart.js from cdnjs), plus JSON and CSV files,
// to projects/demos/out/. Colors follow a validated categorical palette, assigned in fixed order per entity, with
// light and dark steps; every chart has a hover tooltip and its data as a table.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const OUT_DIR = join(__dirname, "..", "..", "out")

/** A point: x (unix seconds for `time` axes, else a number) and y; null y leaves a gap */
export type Point = [number, number | null]

export interface LineSeries {
  label: string
  points: Point[]
  /** hold each value until the next point, for exact change histories */
  step?: boolean
  /** draw the points as dots only, e.g. sparse samples over a dense line */
  dots?: boolean
  dashed?: boolean
  /** fixed palette slot (0-7) for this entity, so it keeps its color across charts */
  slot?: number
}

/** What a section took to read, shown under its title, e.g. "34,590 reads · 5 simulate requests · 3.2 s" */
type Cost = { cost?: string }

export interface LineChart extends Cost {
  kind: "line"
  title: string
  subtitle?: string
  x: "time" | "round" | "number"
  xLabel?: string
  yLabel: string
  logY?: boolean
  /** start the y axis at 0 */
  zeroY?: boolean
  stacked?: boolean
  series: LineSeries[]
}

export interface BarChart extends Cost {
  kind: "bar"
  title: string
  subtitle?: string
  labels: string[]
  yLabel: string
  horizontal?: boolean
  stacked?: boolean
  logY?: boolean
  series: { label: string; values: (number | null)[]; slot?: number }[]
}

export interface Table extends Cost {
  kind: "table"
  title: string
  subtitle?: string
  columns: string[]
  rows: (string | number | bigint | null | undefined)[][]
  /** written to out/<name>-<csv>.csv */
  csv?: string
}

export interface Heatmap extends Cost {
  kind: "heatmap"
  title: string
  subtitle?: string
  rowLabel: string
  colLabel: string
  rows: string[]
  cols: string[]
  /** null = not run or failed */
  values: (number | null)[][]
  /** shown in each cell, e.g. "ms" */
  unit: string
  /** marks the lowest (true) or highest value as best */
  lowerIsBetter?: boolean
  /** per-cell notes shown on hover, e.g. failures */
  notes?: (string | undefined)[][]
}

export interface Text {
  kind: "text"
  title?: string
  /** paragraphs; `code` spans in backticks */
  paragraphs: string[]
}

export type Section = LineChart | BarChart | Table | Heatmap | Text

export interface Stat {
  label: string
  value: string
  note?: string
}

export interface Report {
  title: string
  subtitle: string
  stats?: Stat[]
  sections: Section[]
  /** extra raw data for out/<name>.json */
  data?: unknown
}

/** bigint- and Map-safe JSON */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v),
    space,
  )
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Writes out/<name>.html, out/<name>.json and a CSV per table that names one; returns the HTML path */
export function writeReport(name: string, report: Report): string {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const section of report.sections)
    if (section.kind === "table" && section.csv)
      writeFileSync(
        join(OUT_DIR, `${name}-${section.csv}.csv`),
        [section.columns, ...section.rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n",
      )
  writeFileSync(join(OUT_DIR, `${name}.json`), toJson({ ...report, generatedAt: new Date().toISOString() }, 1))
  const path = join(OUT_DIR, `${name}.html`)
  writeFileSync(path, html(report))
  return path
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const inline = (s: string) => escape(s).replace(/`([^`]+)`/g, "<code>$1</code>")

function html(report: Report): string {
  const stats = (report.stats ?? [])
    .map(
      (s) =>
        `<div class="stat"><div class="stat-label">${escape(s.label)}</div><div class="stat-value">${escape(s.value)}</div>${
          s.note ? `<div class="stat-note">${inline(s.note)}</div>` : ""
        }</div>`,
    )
    .join("")
  const sections = report.sections.map((section, i) => sectionHtml(section, i)).join("\n")
  const charts = report.sections.flatMap((section, i) => (section.kind === "line" || section.kind === "bar" ? [{ id: `c${i}`, spec: section }] : []))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(report.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="viz-root">
<header><h1>${escape(report.title)}</h1><p class="subtitle">${inline(report.subtitle)}</p></header>
${stats ? `<section class="stats">${stats}</section>` : ""}
${sections}
<footer>Generated ${escape(new Date().toISOString())} by abel-ghost-sdk demos on a dtalgorand node.</footer>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
const CHARTS = ${toJson(charts)};
${CLIENT_JS}
</script>
</body>
</html>`
}

function head(section: { title?: string; subtitle?: string; cost?: string }): string {
  return `${section.title ? `<h2>${escape(section.title)}</h2>` : ""}${section.cost ? `<p class="cost">${inline(section.cost)}</p>` : ""}${
    section.subtitle ? `<p class="section-sub">${inline(section.subtitle)}</p>` : ""
  }`
}

function tableHtml(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v)
    const numeric = typeof v === "number" || typeof v === "bigint" || /^-?[\d,.]+%?$/.test(s)
    return `<td${numeric ? ' class="num"' : ""}>${inline(s)}</td>`
  }
  return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map(cell).join("")}</tr>`)
    .join("")}</tbody></table></div>`
}

function sectionHtml(section: Section, i: number): string {
  switch (section.kind) {
    case "text":
      return `<section class="card text">${head(section)}${section.paragraphs.map((p) => `<p>${inline(p)}</p>`).join("")}</section>`
    case "table":
      return `<section class="card">${head(section)}${tableHtml(section.columns, section.rows)}</section>`
    case "heatmap":
      return `<section class="card">${head(section)}${heatmapHtml(section)}</section>`
    case "line":
    case "bar": {
      // the chart's data as a table, for screen readers and for reading exact values
      const table =
        section.kind === "bar"
          ? tableHtml(["", ...section.series.map((s) => s.label)], section.labels.map((label, r) => [label, ...section.series.map((s) => fmt(s.values[r]))]))
          : lineTable(section)
      return `<section class="card">${head(section)}<div class="chart" role="img" aria-label="${escape(section.title)}"><canvas id="c${i}"></canvas></div><details><summary>Data table</summary>${table}</details></section>`
    }
  }
}

function lineTable(chart: LineChart): string {
  // at most 400 rows: the table is for reading values, the JSON has everything
  const xs = [...new Set(chart.series.flatMap((s) => s.points.map(([x]) => x)))].sort((a, b) => a - b)
  const every = Math.max(1, Math.ceil(xs.length / 400))
  const lookup = chart.series.map((s) => new Map(s.points.map(([x, y]) => [x, y])))
  const rows = xs
    .filter((_, i) => i % every === 0)
    .map((x) => [chart.x === "time" ? new Date(x * 1000).toISOString().replace("T", " ").slice(0, 16) : String(x), ...lookup.map((m) => fmt(m.get(x)))])
  return (every > 1 ? `<p class="section-sub">Every ${every}th row of ${xs.length}; the JSON file has them all.</p>` : "") +
    tableHtml([chart.x === "time" ? "time (UTC)" : chart.xLabel ?? chart.x, ...chart.series.map((s) => s.label)], rows)
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return ""
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(+v.toPrecision(6))
}

// sequential blue ramp, light -> dark (reference palette)
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"]

function heatmapHtml(h: Heatmap): string {
  const all = h.values.flat().filter((v): v is number => v !== null)
  const min = Math.min(...all)
  const max = Math.max(...all)
  const best = h.lowerIsBetter === false ? max : min
  const rows = h.rows
    .map((row, r) => {
      const cells = h.cols
        .map((_, c) => {
          const v = h.values[r][c]
          const note = h.notes?.[r]?.[c]
          if (v === null) return `<td class="hm-empty" title="${escape(note ?? "not run")}">${note ? "✕" : "–"}</td>`
          const t = max === min ? 0.5 : (v - min) / (max - min)
          const step = Math.round(t * (RAMP.length - 1))
          const isBest = v === best
          return `<td class="hm${step >= 7 ? " hm-dark" : ""}${isBest ? " hm-best" : ""}" style="background:${RAMP[step]}" title="${escape(
            `${h.rowLabel} ${row}, ${h.colLabel} ${h.cols[c]}: ${fmt(v)} ${h.unit}${note ? ` (${note})` : ""}`,
          )}">${isBest ? "★ " : ""}${fmt(v)}</td>`
        })
        .join("")
      return `<tr><th scope="row">${escape(row)}</th>${cells}</tr>`
    })
    .join("")
  return `<div class="table-wrap"><table class="heatmap"><thead><tr><th>${escape(h.rowLabel)} ↓ / ${escape(h.colLabel)} →</th>${h.cols
    .map((c) => `<th>${escape(c)}</th>`)
    .join("")}</tr></thead><tbody>${rows}</tbody></table></div><p class="section-sub">Darker = more ${escape(h.unit)}. ★ marks the ${
    h.lowerIsBetter === false ? "highest" : "lowest"
  }; ✕ marks a failed run (hover for why).</p>`
}

const CSS = `
.viz-root {
  color-scheme: light;
  --page: #f9f9f7; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #6250d6; --series-8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
}
html, body { margin: 0; }
body { background: #f9f9f7; }
@media (prefers-color-scheme: dark) { body { background: #0d0d0d; } }
.viz-root { background: var(--page); color: var(--text-primary); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; min-height: 100vh; box-sizing: border-box; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 0 0 4px; }
.subtitle, .section-sub { color: var(--text-secondary); margin: 0 0 12px; }
.section-sub { font-size: 13px; }
.cost { display: inline-block; margin: 2px 0 8px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
  font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--grid); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin: 20px 0; }
.stat, .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; }
.stat { padding: 12px 14px; }
.stat-label { color: var(--text-secondary); font-size: 13px; }
.stat-value { font-size: 22px; font-weight: 600; margin-top: 2px; }
.stat-note { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.card { padding: 16px; margin: 16px 0; }
.chart { position: relative; height: 340px; }
details { margin-top: 10px; }
summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
th { color: var(--text-secondary); font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.heatmap td { text-align: right; font-variant-numeric: tabular-nums; color: #0b0b0b; border: 2px solid var(--surface-1); border-radius: 4px; }
.heatmap td.hm-dark { color: #fcfcfb; }
.heatmap td.hm-best { font-weight: 700; outline: 2px solid var(--text-primary); outline-offset: -2px; }
.heatmap td.hm-empty { text-align: center; color: var(--text-muted); }
.text p { margin: 6px 0; }
footer { color: var(--text-muted); font-size: 12px; margin-top: 24px; }
`

const CLIENT_JS = `
const css = (name) => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();
const color = (slot) => css('--series-' + ((slot % 8) + 1));
const fmtNum = (v) => v == null ? '' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+Number(v).toPrecision(6));
const fmtTime = (s) => new Date(s * 1000).toISOString().slice(0, 10);
const fmtTimeLong = (s) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const instances = [];
function render() {
  instances.splice(0).forEach((c) => c.destroy());
  Chart.defaults.color = css('--text-secondary');
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.borderColor = css('--grid');
  for (const { id, spec } of CHARTS) {
    const el = document.getElementById(id);
    const legend = { display: spec.series.length >= 2, labels: { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2 } };
    const grid = { color: css('--grid') };
    const yScale = { type: spec.logY ? 'logarithmic' : 'linear', title: { display: true, text: spec.yLabel }, grid, beginAtZero: !!spec.zeroY, stacked: !!spec.stacked, ticks: { callback: (v) => fmtNum(v) } };
    if (spec.kind === 'line') {
      const isTime = spec.x === 'time';
      const datasets = spec.series.map((s, i) => {
        const c = color(s.slot ?? i);
        return { label: s.label, data: s.points.map(([x, y]) => ({ x, y })), borderColor: c, backgroundColor: spec.stacked ? c + '55' : c,
          borderWidth: 2, pointRadius: s.dots ? 3 : 0, pointHoverRadius: 5, showLine: !s.dots, stepped: s.step ? 'before' : false,
          borderDash: s.dashed ? [6, 4] : undefined, fill: spec.stacked ? 'stack' : false, spanGaps: false, parsing: false, normalized: true };
      });
      instances.push(new Chart(el, { type: 'line', data: { datasets },
        options: { animation: false, maintainAspectRatio: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: { legend, decimation: { enabled: true, algorithm: 'lttb', samples: 800 },
            tooltip: { callbacks: { title: (items) => items.length ? (isTime ? fmtTimeLong(items[0].parsed.x) : (spec.xLabel ?? 'x') + ' ' + fmtNum(items[0].parsed.x)) : '',
              label: (item) => ' ' + item.dataset.label + ': ' + fmtNum(item.parsed.y) } } },
          scales: { x: { type: 'linear', title: { display: !!spec.xLabel || isTime, text: isTime ? 'date (UTC)' : spec.xLabel }, grid,
              ticks: { maxTicksLimit: 8, callback: (v) => isTime ? fmtTime(v) : fmtNum(v) } }, y: yScale } } }));
    } else {
      const datasets = spec.series.map((s, i) => {
        const c = color(s.slot ?? i);
        return { label: s.label, data: s.values, backgroundColor: c, borderColor: css('--surface-1'), borderWidth: { top: 0, right: 0, bottom: 0, left: 0 },
          borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.8, barPercentage: 0.9 };
      });
      const cat = { grid: { display: false }, stacked: !!spec.stacked, ticks: { autoSkip: false, font: { size: 11 } } };
      // bars encode length, so their value axis always starts at zero
      if (!spec.logY) yScale.beginAtZero = true;
      instances.push(new Chart(el, { type: 'bar', data: { labels: spec.labels, datasets },
        options: { animation: false, maintainAspectRatio: false, indexAxis: spec.horizontal ? 'y' : 'x',
          plugins: { legend, tooltip: { callbacks: { label: (item) => ' ' + item.dataset.label + ': ' + fmtNum(item.raw) } } },
          scales: spec.horizontal ? { y: cat, x: yScale } : { x: cat, y: yScale } } }));
    }
  }
}
render();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
`
