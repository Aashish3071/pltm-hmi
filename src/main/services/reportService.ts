import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { app, BrowserWindow } from 'electron'
import ExcelJS from 'exceljs'
import pkg from '../../../package.json'
import { PRODUCT_NAME } from '@shared/brand'
import { ErrorCode, type ModelConfig, type ReportResult, type Sample, type TestResults } from '@shared/types'
import { computeResults, formatResult, sortedPoints } from '@shared/analysis'
import { modelsRepo, settingsRepo, testRunsRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log } from '../logger'
import { currentUser } from './authService'
import { getMachineSettings } from './configService'
import { currentTest } from './testService'

export function reportDir(): string {
  const configured = settingsRepo.get('report_output_dir')
  return configured && configured.trim() ? configured : join(app.getPath('documents'), `${PRODUCT_NAME} Reports`)
}

export interface ReportData {
  date: Date
  modelName: string
  partNo: string
  employee: string
  speedText: string
  machineId: string
  company: string[]
  results: TestResults
  model: ModelConfig | null
  samples: Sample[]
}

function collect(): ReportData {
  const test = currentTest()
  if (!test) throw new CommandError(ErrorCode.NO_TEST)
  const run = testRunsRepo.get(test.runId)
  const model = run?.modelId ? (modelsRepo.get(run.modelId) ?? null) : null
  const machine = getMachineSettings()
  const speeds = settingsRepo.getSpeeds()
  return {
    date: new Date(),
    modelName: run?.modelName ?? model?.name ?? '',
    partNo: run?.partNo || '#####',
    employee: currentUser()?.displayName ?? run?.employeeName ?? '',
    speedText: machine.measurementSpeedText || `${trimNumber(speeds.up)} mm/s`,
    machineId: machine.machineId,
    company: [machine.company.name, machine.company.addressLine1, machine.company.addressLine2].filter(Boolean),
    results: computeResults(test.samples, model),
    model,
    samples: test.samples
  }
}

/** File name from the model, the part number and the time, e.g. PANTO-3600_P-001_20260118_143005. */
export function reportBaseName(data: Pick<ReportData, 'modelName' | 'partNo' | 'date'>): string {
  const clean = (s: string): string => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'NA'
  return `${clean(data.modelName)}_${clean(data.partNo)}_${stamp(data.date)}`
}

/** REPORT: an Excel workbook, a PDF and the data as JSON. */
export async function generateReport(chartPngDataUrl?: string): Promise<ReportResult> {
  const data = collect()
  const dir = reportDir()
  mkdirSync(dir, { recursive: true })
  const base = join(dir, reportBaseName(data))
  const png = chartPngDataUrl?.startsWith('data:image/png;base64,')
    ? chartPngDataUrl.slice('data:image/png;base64,'.length)
    : null
  const excelPath = `${base}.xlsx`
  const pdfPath = `${base}.pdf`
  const jsonPath = `${base}.json`
  await writeExcel(data, png, excelPath)
  await writePdf(data, png, pdfPath)
  writeFileSync(jsonPath, JSON.stringify(reportJson(data), null, 2))
  const test = currentTest()
  if (test) testRunsRepo.setReportPath(test.runId, excelPath)
  log.info(`Report written: ${base}.{xlsx,pdf,json}`)
  return { excelPath, pdfPath, jsonPath }
}

function detailRows(data: ReportData): [string, string][] {
  return [
    ['Pantograph type (model)', data.modelName],
    ['Serial / part number', data.partNo],
    ['Date of measurement', dateText(data.date)],
    ['Operator', data.employee],
    ['Machine ID', data.machineId],
    ['Speed of measurement', data.speedText],
    ['Conditions', 'Static contact force, measured without damper']
  ]
}

function resultRows(r: TestResults): [string, number, string][] {
  return [
    ['Average up force (raising)', r.avgUpN, 'N'],
    ['Average down force (lowering)', r.avgDownN, 'N'],
    ['Mean force', r.meanN, 'N'],
    ['Peak friction', r.peakFrictionN, 'N'],
    ['Hysteresis', r.hysteresisN, 'N'],
    ['Height reached', r.maxHeightMm, 'mm']
  ]
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export async function writeExcel(data: ReportData, png: string | null, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  wb.creator = PRODUCT_NAME
  wb.created = data.date
  const ws = wb.addWorksheet('Report', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  })
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 10 }, { width: 4 }, { width: 14 }, { width: 14 }]
  const navy: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12263A' } }
  const soft: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6ECF1' } }

  ws.mergeCells('A1:F1')
  ws.getCell('A1').value = 'Pantograph Static Contact Force — Test Report'
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }
  ws.getCell('A1').fill = navy
  ws.getRow(1).height = 28
  let row = 2
  data.company.forEach((line, i) => {
    ws.mergeCells(`A${row}:F${row}`)
    ws.getCell(`A${row}`).value = line
    ws.getCell(`A${row}`).font = { bold: i === 0, size: i === 0 ? 12 : 10 }
    row++
  })
  row++
  const section = (title: string): void => {
    ws.mergeCells(`A${row}:F${row}`)
    ws.getCell(`A${row}`).value = title
    ws.getCell(`A${row}`).font = { bold: true, size: 11 }
    ws.getCell(`A${row}`).fill = soft
    row++
  }
  section('Test details')
  for (const [k, v] of detailRows(data)) {
    ws.getCell(`A${row}`).value = k
    ws.mergeCells(`B${row}:F${row}`)
    ws.getCell(`B${row}`).value = v
    ws.getCell(`B${row}`).font = { bold: true }
    row++
  }
  row++
  section(`Results (averaged between ${data.results.windowFromMm} and ${data.results.windowToMm} mm)`)
  for (const [k, v, unit] of resultRows(data.results)) {
    ws.getCell(`A${row}`).value = k
    ws.getCell(`B${row}`).value = Math.round(v * 1e5) / 1e5
    ws.getCell(`B${row}`).numFmt = unit === 'mm' ? '0' : '0.00###'
    ws.getCell(`B${row}`).font = { bold: true }
    ws.getCell(`C${row}`).value = unit
    row++
  }
  row++
  if (data.model) {
    section('Reference profile')
    ws.getCell(`A${row}`).value = 'Point'
    ws.getCell(`B${row}`).value = 'Load (N)'
    ws.getCell(`C${row}`).value = 'Height (mm)'
    ws.getRow(row).font = { bold: true }
    row++
    for (const p of sortedPoints(data.model)) {
      ws.getCell(`A${row}`).value = p.rowIndex === 4 ? `${p.rowIndex} (travel)` : p.rowIndex
      ws.getCell(`B${row}`).value = p.loadN
      ws.getCell(`C${row}`).value = p.heightMm
      row++
    }
    row++
  }
  if (png) {
    section('Load vs height')
    const id = wb.addImage({ base64: png, extension: 'png' })
    ws.addImage(id, { tl: { col: 0, row: row - 1 }, ext: { width: 420, height: 500 } })
    row += 27
  }
  row++
  ws.mergeCells(`A${row}:C${row}`)
  ws.getCell(`A${row}`).value = 'Tested by: ____________________'
  ws.mergeCells(`D${row}:F${row}`)
  ws.getCell(`D${row}`).value = 'Approved by: ____________________'
  row += 2
  ws.mergeCells(`A${row}:F${row}`)
  ws.getCell(`A${row}`).value = `Generated by ${PRODUCT_NAME} ${pkg.version}`
  ws.getCell(`A${row}`).font = { size: 8, color: { argb: 'FF7D8B99' } }

  const sheet = wb.addWorksheet('Data')
  sheet.columns = [
    { header: '#', width: 8 },
    { header: 'Load (N)', width: 12 },
    { header: 'Position (mm)', width: 14 },
    { header: 'Status code', width: 12 }
  ]
  sheet.getRow(1).font = { bold: true }
  data.samples.forEach((s, i) => sheet.addRow([i + 1, s.loadN, s.positionMm, s.code]))

  await wb.xlsx.writeFile(file)
}

// ---------------------------------------------------------------------------
// PDF (A4)
// ---------------------------------------------------------------------------

export async function writePdf(data: ReportData, png: string | null, file: string): Promise<void> {
  const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, javascript: false } })
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reportHtml(data, png))}`)
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    writeFileSync(file, pdf)
  } finally {
    window.destroy()
  }
}

export function reportHtml(data: ReportData, png: string | null): string {
  const r = data.results
  const details = detailRows(data)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('')
  const results = resultRows(r)
    .map(
      ([k, v, unit]) =>
        `<tr><th>${esc(k)}</th><td class="num">${esc(unit === 'mm' ? String(v) : formatResult(v))}</td><td class="unit">${unit}</td></tr>`
    )
    .join('')
  const profile = data.model
    ? sortedPoints(data.model)
        .map(
          (p) =>
            `<tr><td>${p.rowIndex}${p.rowIndex === 4 ? ' (travel)' : ''}</td><td class="num">${p.loadN}</td><td class="num">${p.heightMm}</td></tr>`
        )
        .join('')
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #0f2233; font-size: 10.5pt }
.page { width: 210mm; height: 296mm; padding: 14mm 15mm 12mm; position: relative; overflow: hidden }
.band { background: #12263a; color: white; padding: 10px 14px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center }
.band h1 { margin: 0; font-size: 15pt }
.band .sub { font-size: 9pt; color: #9fb3c6 }
.company { margin: 10px 2px 0; font-size: 10pt; color: #44566a }
.company b { color: #0f2233; font-size: 11.5pt }
h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .6px; color: #44566a; margin: 14px 0 6px; border-bottom: 1.5px solid #0f9d8f; padding-bottom: 3px }
table { border-collapse: collapse; width: 100% }
th, td { padding: 3.5px 6px; border-bottom: 1px solid #e1e7ec; text-align: left; vertical-align: top }
th { font-weight: 600; color: #44566a; width: 46% }
td.num { text-align: right; font-family: Consolas, monospace; font-weight: 700 }
td.unit { width: 40px; color: #7d8b99 }
.cols { display: flex; gap: 16px }
.cols > div { flex: 1 }
.chart { display: block; margin: 0 auto; height: 108mm; border: 1px solid #e1e7ec; border-radius: 6px }
.profile td, .profile th { font-size: 9pt; padding: 2px 6px }
.sign { display: flex; gap: 30px; margin-top: 18px; font-size: 10pt }
.sign div { flex: 1; border-top: 1px solid #0f2233; padding-top: 4px; color: #44566a }
.foot { position: absolute; left: 15mm; right: 15mm; bottom: 8mm; font-size: 8pt; color: #7d8b99; display: flex; justify-content: space-between }
</style></head><body><div class="page">
<div class="band"><div><h1>Static Contact Force — Test Report</h1><div class="sub">Pantograph load test</div></div><div class="sub">${esc(dateText(data.date))}</div></div>
${data.company.length ? `<div class="company"><b>${esc(data.company[0])}</b>${data.company.slice(1).map((l) => `<br>${esc(l)}`).join('')}</div>` : ''}
<h2>Test details</h2><table>${details}</table>
<div class="cols">
<div><h2>Results</h2><table>${results}</table><p style="font-size:8.5pt;color:#7d8b99;margin:4px 0 0">Averages between ${r.windowFromMm} and ${r.windowToMm} mm. Mean = (up + down) / 2; hysteresis = down − up; peak friction = max(down) − min(up).</p></div>
<div><h2>Reference profile</h2><table class="profile"><tr><th>Point</th><th>Load (N)</th><th>Height (mm)</th></tr>${profile}</table></div>
</div>
${png ? `<h2>Load vs height</h2><img class="chart" src="data:image/png;base64,${png}">` : ''}
<div class="sign"><div>Tested by</div><div>Approved by</div></div>
<div class="foot"><span>${esc(data.modelName)} · ${esc(data.partNo)}</span><span>Generated by ${esc(PRODUCT_NAME)} ${esc(pkg.version)}</span></div>
</div></body></html>`
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function reportJson(data: ReportData): unknown {
  const r = data.results
  return {
    report: 'Pantograph static contact force test',
    generatedBy: `${PRODUCT_NAME} ${pkg.version}`,
    dateOfMeasurement: dateText(data.date),
    company: data.company,
    machineId: data.machineId,
    model: data.modelName,
    partNo: data.partNo,
    operator: data.employee,
    speedOfMeasurement: data.speedText,
    results: {
      averageUpForceN: round(r.avgUpN),
      averageDownForceN: round(r.avgDownN),
      meanForceN: round(r.meanN),
      peakFrictionN: round(r.peakFrictionN),
      hysteresisN: round(r.hysteresisN),
      heightReachedMm: r.maxHeightMm,
      averagedBetweenMm: [r.windowFromMm, r.windowToMm]
    },
    referenceProfile: data.model
      ? sortedPoints(data.model).map((p) => ({ point: p.rowIndex, loadN: p.loadN, heightMm: p.heightMm }))
      : [],
    samples: {
      columns: ['loadN', 'positionMm', 'statusCode'],
      rows: data.samples.map((s) => [s.loadN, s.positionMm, s.code])
    }
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function dateText(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function round(v: number): number {
  return Math.round(v * 1e5) / 1e5
}

function trimNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}
