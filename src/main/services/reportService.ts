import { join } from 'path'
import { mkdirSync } from 'fs'
import { app } from 'electron'
import ExcelJS from 'exceljs'
import { ErrorCode, type ModelPoint, type TestRunSummary } from '@shared/types'
import { modelsRepo, settingsRepo, testRunsRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log } from '../logger'

export function reportDir(): string {
  const configured = settingsRepo.get('report_output_dir')
  return configured && configured.trim().length > 0
    ? configured
    : join(app.getPath('documents'), 'PLTM Reports')
}

export interface RunChartData {
  run: TestRunSummary
  points: { loadN: number; heightMm: number }[]
  envelope: { loadN: number; heightMm: number }[]
  maxHeightMm: number
}

/** Everything the renderer needs to redraw a saved run's graph for the report. */
export function runChartData(runId: number): RunChartData {
  const run = testRunsRepo.get(runId)
  if (!run) throw new CommandError(ErrorCode.NO_COMPLETED_RUN)
  const modelId = testRunsRepo.modelIdOf(runId)
  const model = modelId ? modelsRepo.getIncludingArchived(modelId) : undefined
  const envelope = model
    ? [...model.points]
        .sort((a, b) => a.rowIndex - b.rowIndex)
        .map((p) => ({ loadN: p.loadN, heightMm: p.heightMm }))
    : []
  return {
    run,
    points: testRunsRepo.points(runId).map((p) => ({ loadN: p.loadN, heightMm: p.heightMm })),
    envelope,
    maxHeightMm: model?.distanceMm ?? Number(settingsRepo.get('height_capacity_mm') ?? 4000)
  }
}

/**
 * exceljs cannot author native charts, so the renderer draws the run's graph
 * and hands over a PNG, embedded alongside the raw data.
 */
export async function generateReport(runId: number, chartPngDataUrl?: string): Promise<string> {
  const run = testRunsRepo.get(runId)
  if (!run) throw new CommandError(ErrorCode.NO_COMPLETED_RUN)
  const points = testRunsRepo.points(runId)
  const modelId = testRunsRepo.modelIdOf(runId)
  const profile: ModelPoint[] = modelId
    ? (modelsRepo.getIncludingArchived(modelId)?.points ?? [])
    : []

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PLTM HMI'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Test Report')
  sheet.columns = [{ width: 22 }, { width: 22 }, { width: 16 }, { width: 16 }, { width: 12 }]

  sheet.mergeCells('A1:E1')
  const title = sheet.getCell('A1')
  title.value = 'PANTOGRAPH LOAD TEST REPORT'
  title.font = { bold: true, size: 16 }
  title.alignment = { horizontal: 'center' }

  const header: [string, string | number][] = [
    ['Machine ID', settingsRepo.get('machine_id') ?? '-'],
    ['Employee', run.employeeName ?? '-'],
    ['Model', run.modelName ?? '-'],
    ['Part No', run.partNo ?? '-'],
    ['Started', run.startedAt],
    ['Ended', run.endedAt ?? '-'],
    ['Up Cycle (s)', run.upCycleSec ?? 0],
    ['Down Cycle (s)', run.downCycleSec ?? 0],
    ['Max Load (N)', run.maxLoadN ?? 0],
    ['Result', run.resultStatus ?? '-']
  ]
  header.forEach(([label, value], i) => {
    const row = sheet.getRow(3 + i)
    row.getCell(1).value = label
    row.getCell(1).font = { bold: true }
    row.getCell(2).value = value
  })

  let cursor = 3 + header.length + 1
  if (profile.length > 0) {
    const label = sheet.getRow(cursor).getCell(1)
    label.value = 'Model Profile'
    label.font = { bold: true }
    cursor++
    styleHeader(sheet.getRow(cursor), ['Row', 'Load (N)', 'Height (mm)'])
    for (const p of [...profile].sort((a, b) => a.rowIndex - b.rowIndex)) {
      cursor++
      const row = sheet.getRow(cursor)
      row.getCell(1).value = p.rowIndex
      row.getCell(2).value = p.loadN
      row.getCell(3).value = p.heightMm
    }
    cursor += 2
  }

  const dataLabel = sheet.getRow(cursor).getCell(1)
  dataLabel.value = 'Recorded Data'
  dataLabel.font = { bold: true }
  cursor++
  styleHeader(sheet.getRow(cursor), ['Time (ms)', 'Load (N)', 'Height (mm)', 'Phase'])
  points.forEach((p, i) => {
    const row = sheet.getRow(cursor + 1 + i)
    row.getCell(1).value = p.tMs
    row.getCell(2).value = p.loadN
    row.getCell(3).value = p.heightMm
    row.getCell(4).value = p.phase
  })

  if (chartPngDataUrl?.startsWith('data:image/png;base64,')) {
    const imageId = workbook.addImage({
      base64: chartPngDataUrl.replace('data:image/png;base64,', ''),
      extension: 'png'
    })
    sheet.addImage(imageId, { tl: { col: 6, row: 2 }, ext: { width: 520, height: 400 } })
  }

  const dir = reportDir()
  const safe = (value: string): string => value.replace(/[^\w.-]+/g, '_')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filePath = join(
    dir,
    `${safe(run.modelName ?? 'MODEL')}_${safe(run.partNo ?? 'PART')}_${stamp}.xlsx`
  )
  try {
    mkdirSync(dir, { recursive: true })
    await workbook.xlsx.writeFile(filePath)
  } catch (error) {
    log.error(`Report write failed: ${filePath}`, error)
    throw new CommandError(
      ErrorCode.INVALID_INPUT,
      `Could not save the report to ${dir}. Check the folder exists and is writable (Settings > Report Folder).`
    )
  }
  testRunsRepo.setReportPath(runId, filePath)
  log.info(`Report saved: ${filePath}`)
  return filePath
}

function styleHeader(row: ExcelJS.Row, labels: string[]): void {
  labels.forEach((label, i) => {
    const cell = row.getCell(i + 1)
    cell.value = label
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } }
    cell.border = { bottom: { style: 'thin' } }
  })
}
