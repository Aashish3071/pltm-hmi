import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import { app, BrowserWindow } from 'electron'
import type { Calibration, LoadCellCertificate, ModelConfig, TestRunSummary } from '@shared/types'
import { getDb } from '../db'
import { settingsRepo } from '../db/repositories'
import type { RunAnalysis, RunSample } from './testAnalysis'

export interface CertificateInput {
  certificateNo: string
  run: TestRunSummary
  model: ModelConfig | undefined
  samples: (RunSample & { tMs: number })[]
  analysis: RunAnalysis
  calibration: Calibration | undefined
  loadCellCertificate: LoadCellCertificate | undefined
}

/**
 * Allocates the next certificate number, e.g. PLTM-0001/2026/00012. Numbers
 * are never reused: a run keeps the number it was first given.
 */
export function nextCertificateNo(): string {
  const db = getDb()
  return db.transaction(() => {
    const seq = Number(settingsRepo.get('certificate_seq') ?? 0) + 1
    settingsRepo.set('certificate_seq', String(seq))
    const machineId = settingsRepo.get('machine_id') ?? 'PLTM'
    return `${machineId}/${new Date().getFullYear()}/${String(seq).padStart(5, '0')}`
  })()
}

/** Tamper-evidence: a hash of the stored record the certificate was printed from. */
export function recordFingerprint(input: CertificateInput): string {
  const payload = JSON.stringify({
    run: input.run,
    samples: input.samples.map((s) => [s.tMs, s.loadN, s.heightMm, s.phase])
  })
  return createHash('sha256').update(payload).digest('hex')
}

export async function writeCertificatePdf(input: CertificateInput, filePath: string): Promise<void> {
  const html = certificateHtml(input)
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, javascript: false }
  })
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.45, bottom: 0.6, left: 0.5, right: 0.5 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-family:Arial,sans-serif;font-size:7.5px;color:#666;width:100%;padding:0 36px;display:flex;justify-content:space-between"><span>Certificate ${esc(input.certificateNo)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`
    })
    writeFileSync(filePath, pdf)
  } finally {
    window.destroy()
  }
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

function certificateHtml(input: CertificateInput): string {
  const { run, model, analysis, calibration, loadCellCertificate: lcc } = input
  const s = settingsRepo.getAll()
  const testDate = (run.startedAt ?? '').slice(0, 10)
  const calAtTest = calibration ? validOn(calibration.dueDate, testDate) : null
  const lccAtTest = lcc ? validOn(lcc.validUntil, testDate) : null
  const fingerprint = recordFingerprint(input)

  const fmt = (n: number | null | undefined, unit = ' N'): string =>
    n === null || n === undefined ? '—' : `${n.toFixed(1)}${unit}`

  const rows = analysis.rows
    .map(
      (r) => `<tr><td>${r.heightMm}</td><td>${fmt(r.raisingN, '')}</td><td>${fmt(r.loweringN, '')}</td><td>${fmt(r.meanN, '')}</td><td>${fmt(r.hysteresisN, '')}</td></tr>`
    )
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(input.certificateNo)}</title><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1b1b1b; font-size: 10.5px; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #2f5fd0; padding-bottom: 8px; }
  .company { font-size: 15px; font-weight: 700; color: #2f5fd0; }
  .addr { color: #555; font-size: 9.5px; white-space: pre-line; max-width: 300px; }
  .title { text-align: right; }
  .title h1 { font-size: 15px; margin: 0 0 4px; }
  .title .no { font-size: 11px; font-weight: 700; }
  h2 { font-size: 11.5px; margin: 14px 0 5px; color: #2f5fd0; text-transform: uppercase; letter-spacing: 0.4px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #c8ced8; padding: 3.5px 6px; text-align: left; vertical-align: top; }
  th { background: #eef2fb; font-weight: 700; }
  .kv td:nth-child(odd) { width: 22%; background: #f6f8fc; font-weight: 700; }
  .num td, .num th { text-align: right; }
  .num td:first-child, .num th:first-child { text-align: left; }
  .verdict { border: 1.5px solid #c9a800; background: #fff8d6; padding: 7px 9px; margin-top: 4px; }
  .ok { color: #1f7a32; font-weight: 700; } .bad { color: #b02525; font-weight: 700; }
  .graph { border: 1px solid #c8ced8; padding: 6px; text-align: center; page-break-inside: avoid; }
  .signs { display: flex; gap: 16px; margin-top: 26px; page-break-inside: avoid; }
  .sign { flex: 1; border-top: 1px solid #555; padding-top: 4px; font-size: 9.5px; }
  .foot { margin-top: 14px; font-size: 8px; color: #666; word-break: break-all; }
  .section { page-break-inside: avoid; }
  </style></head><body>
  <div class="head">
    <div><div class="company">${esc(s.company_name || 'Company')}</div><div class="addr">${esc(s.company_address ?? '')}</div></div>
    <div class="title"><h1>Pantograph Static Contact Force<br>Test Certificate</h1>
      <div class="no">No. ${esc(input.certificateNo)}</div><div>Issued ${esc(localDateTime(new Date().toISOString()))}</div></div>
  </div>

  <div class="section"><h2>Test particulars</h2>
  <table class="kv">
    <tr><td>Pantograph model</td><td>${esc(run.modelName ?? '—')}</td><td>Part / serial no.</td><td>${esc(run.partNo ?? '—')}</td></tr>
    <tr><td>Test bench (machine ID)</td><td>${esc(s.machine_id ?? '—')}</td><td>Tested by</td><td>${esc(run.employeeName ?? '—')}</td></tr>
    <tr><td>Test started</td><td>${esc(localDateTime(run.startedAt))}</td><td>Test ended</td><td>${esc(run.endedAt ? localDateTime(run.endedAt) : '—')}</td></tr>
    <tr><td>Raising time</td><td>${fmt(run.upCycleSec, ' s')}</td><td>Lowering time</td><td>${fmt(run.downCycleSec, ' s')}</td></tr>
    <tr><td>Travel distance</td><td>${model ? `${model.distanceMm} mm` : '—'}</td><td>Run result</td><td>${esc(run.resultStatus ?? '—')}</td></tr>
  </table></div>

  <div class="section"><h2>Result</h2>
  <table class="kv">
    <tr><td>Mean static contact force</td><td>${fmt(analysis.meanStaticN)}</td><td>Largest hysteresis (Fl − Fr)</td><td>${fmt(analysis.maxHysteresisN)}</td></tr>
    <tr><td>Raising force Fr (min / mean / max)</td><td>${analysis.raising ? `${fmt(analysis.raising.minN, '')} / ${fmt(analysis.raising.meanN, '')} / ${fmt(analysis.raising.maxN)}` : '—'}</td>
        <td>Lowering force Fl (min / mean / max)</td><td>${analysis.lowering ? `${fmt(analysis.lowering.minN, '')} / ${fmt(analysis.lowering.meanN, '')} / ${fmt(analysis.lowering.maxN)}` : '—'}</td></tr>
  </table>
  <div class="verdict"><b>Acceptance verdict: not evaluated.</b> Acceptance limits for this model are not configured in this software version, so this certificate records measured values only.</div>
  </div>

  <div class="section"><h2>Static contact force by height</h2>
  <table class="num"><tr><th>Height (mm)</th><th>Raising Fr (N)</th><th>Lowering Fl (N)</th><th>Mean (N)</th><th>Hysteresis Fl − Fr (N)</th></tr>${rows || '<tr><td colspan="5">No movement was recorded.</td></tr>'}</table>
  <div style="color:#555;margin-top:3px">Evaluated between ${analysis.fromMm} and ${analysis.toMm} mm; the first and last 5% of travel (start and turnaround) are excluded. ${analysis.samples} readings recorded.</div>
  </div>

  <div class="section"><h2>Force against height</h2><div class="graph">${graphSvg(input)}</div></div>

  <div class="section"><h2>Measuring equipment and calibration</h2>
  <table class="kv">
    <tr><td>Load-cell calibration</td><td colspan="3">${
      calibration
        ? `Calibrated ${esc(localDateTime(calibration.performedAt))} by ${esc(calibration.performedBy)}; ${calibration.points.length} points; largest error ${calibration.maxErrorN.toFixed(2)} N (limit ${calibration.maxPermissibleErrorN.toFixed(2)} N); due ${esc(calibration.dueDate)} — ${calAtTest ? '<span class="ok">valid on the test date</span>' : '<span class="bad">overdue on the test date</span>'}${calibration.referenceDevice ? `<br>Reference: ${esc(calibration.referenceDevice)}${calibration.referenceCertificateNo ? `, certificate ${esc(calibration.referenceCertificateNo)}` : ''}` : ''}`
        : '<span class="bad">No calibration recorded at the time of the test.</span>'
    }</td></tr>
    <tr><td>Accredited load-cell certificate</td><td colspan="3">${
      lcc
        ? `${esc(lcc.labName)}${lcc.accreditationNo ? ` (accreditation ${esc(lcc.accreditationNo)})` : ''}, certificate ${esc(lcc.certificateNo)}${lcc.loadCellSerial ? `, load cell s/n ${esc(lcc.loadCellSerial)}` : ''}; calibrated ${esc(lcc.calibratedOn)}, valid until ${esc(lcc.validUntil)}${lcc.uncertainty ? `; uncertainty ${esc(lcc.uncertainty)}` : ''} — ${lccAtTest ? '<span class="ok">valid on the test date</span>' : '<span class="bad">expired on the test date</span>'}`
        : '<span class="bad">No accredited certificate recorded at the time of the test.</span>'
    }</td></tr>
  </table></div>

  <div class="signs">
    <div class="sign">Tested by: ${esc(run.employeeName ?? '')}<br><br>Signature / date</div>
    <div class="sign">Checked by<br><br>Signature / date</div>
    <div class="sign">Approved by<br><br>Signature / date</div>
  </div>

  <div class="foot">Generated by PLTM HMI ${esc(app.getVersion())} from test record #${run.id}. Record fingerprint (SHA-256): ${fingerprint}</div>
  </body></html>`
}

function graphSvg(input: CertificateInput): string {
  const W = 660
  const H = 330
  const pad = { left: 54, right: 16, top: 12, bottom: 38 }
  const up = input.samples.filter((p) => p.phase === 'up')
  const down = input.samples.filter((p) => p.phase === 'down')
  const envelope = input.model
    ? [...input.model.points].sort((a, b) => a.rowIndex - b.rowIndex)
    : []
  const allLoads = [...input.samples.map((p) => p.loadN), ...envelope.map((p) => p.loadN * 1.5)]
  const maxLoad = niceCeil(Math.max(150, ...allLoads))
  const allHeights = [...input.samples.map((p) => p.heightMm), input.model?.distanceMm ?? 0]
  const maxHeight = niceCeil(Math.max(100, ...allHeights) * 1.05)
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const x = (load: number): number => pad.left + (load / maxLoad) * plotW
  const y = (height: number): number => pad.top + plotH - (height / maxHeight) * plotH
  const line = (pts: { loadN: number; heightMm: number }[]): string =>
    pts.map((p) => `${x(p.loadN).toFixed(1)},${y(p.heightMm).toFixed(1)}`).join(' ')

  const grid: string[] = []
  for (let i = 0; i <= 6; i++) {
    const v = (maxLoad / 6) * i
    grid.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${pad.top}" y2="${pad.top + plotH}" stroke="#e1e4ea"/><text x="${x(v)}" y="${pad.top + plotH + 14}" text-anchor="middle">${Math.round(v)}</text>`)
  }
  for (let i = 0; i <= 6; i++) {
    const v = (maxHeight / 6) * i
    grid.push(`<line x1="${pad.left}" x2="${pad.left + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="#e1e4ea"/><text x="${pad.left - 6}" y="${y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial" font-size="9" fill="#444">
    ${grid.join('')}
    <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#555"/>
    ${envelope.length > 1 ? `<polyline points="${line(envelope)}" fill="none" stroke="#9aa0ad" stroke-dasharray="4 3" stroke-width="1"/>` : ''}
    ${up.length > 1 ? `<polyline points="${line(up)}" fill="none" stroke="#c92a2a" stroke-width="1.4"/>` : ''}
    ${down.length > 1 ? `<polyline points="${line(down)}" fill="none" stroke="#1c7ed6" stroke-width="1.4"/>` : ''}
    <text x="${pad.left + plotW / 2}" y="${H - 6}" text-anchor="middle" font-weight="bold" fill="#1b1b1b">Static contact force (N)</text>
    <text transform="translate(13 ${pad.top + plotH / 2}) rotate(-90)" text-anchor="middle" font-weight="bold" fill="#1b1b1b">Height (mm)</text>
    <g transform="translate(${pad.left + plotW - 196} ${pad.top + 8})">
      <rect width="188" height="44" fill="#fff" stroke="#c8ced8"/>
      <line x1="8" x2="28" y1="11" y2="11" stroke="#c92a2a" stroke-width="1.6"/><text x="34" y="14">Raising (Fr)</text>
      <line x1="8" x2="28" y1="23" y2="23" stroke="#1c7ed6" stroke-width="1.6"/><text x="34" y="26">Lowering (Fl)</text>
      <line x1="8" x2="28" y1="35" y2="35" stroke="#9aa0ad" stroke-dasharray="4 3"/><text x="34" y="38">Model profile</text>
    </g>
  </svg>`
}

function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2)
}

/** SQLite's datetime('now') is UTC without a zone; ISO strings carry one. */
function localDateTime(value: string | null): string {
  if (!value) return '—'
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

function validOn(validUntil: string, date: string): boolean {
  return !date || validUntil >= date
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
