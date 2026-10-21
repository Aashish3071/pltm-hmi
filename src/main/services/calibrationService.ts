import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { fitCalibration } from '@shared/calibration'
import {
  ErrorCode,
  type Calibration,
  type CalibrationCapture,
  type CalibrationDraft,
  type CalibrationPolicy,
  type CalibrationStatus,
  type CertificateDraft,
  type TelemetryFrame,
  type ValidityState
} from '@shared/types'
import { calibrationsRepo, loadCellCertificatesRepo, settingsRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { getHardware } from '../hardware/HardwareManager'
import { log } from '../logger'

/** A due date this close counts as "due soon". */
const DUE_SOON_DAYS = 30
const DEFAULT_CAPTURE_MS = 2000
const MAX_POINTS = 11

function invalid(message: string): CommandError {
  return new CommandError(ErrorCode.INVALID_INPUT, message)
}

// ---------------------------------------------------------------------------
// Dates (calendar days, local time, YYYY-MM-DD)
// ---------------------------------------------------------------------------

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5)
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(d, lastDay))}`
}

function validity(dueDate: string | undefined): { state: ValidityState; days: number | null } {
  if (!dueDate) return { state: 'missing', days: null }
  const days = daysBetween(today(), dueDate)
  if (days < 0) return { state: 'overdue', days }
  if (days <= DUE_SOON_DAYS) return { state: 'due-soon', days }
  return { state: 'ok', days }
}

// ---------------------------------------------------------------------------
// Policy and status
// ---------------------------------------------------------------------------

export function getPolicy(): CalibrationPolicy {
  const s = settingsRepo.getAll()
  return {
    enforcement: s.calibration_enforcement === 'block' ? 'block' : 'warn',
    intervalMonths: Number(s.calibration_interval_months ?? 12),
    maxPermissibleErrorN: Number(s.calibration_mpe_n ?? 1)
  }
}

export function setPolicy(input: CalibrationPolicy): CalibrationPolicy {
  if (input?.enforcement !== 'warn' && input?.enforcement !== 'block') {
    throw invalid('Choose whether an overdue calibration warns or blocks tests.')
  }
  const interval = Number(input.intervalMonths)
  if (!Number.isInteger(interval) || interval < 1 || interval > 36) {
    throw invalid('Calibration interval must be 1 to 36 months.')
  }
  const mpe = Number(input.maxPermissibleErrorN)
  if (!Number.isFinite(mpe) || mpe <= 0 || mpe > 50) {
    throw invalid('Maximum permissible error must be above 0 and at most 50 N.')
  }
  settingsRepo.set('calibration_enforcement', input.enforcement)
  settingsRepo.set('calibration_interval_months', String(interval))
  settingsRepo.set('calibration_mpe_n', String(mpe))
  return getPolicy()
}

export function getStatus(): CalibrationStatus {
  const calibration = calibrationsRepo.active() ?? null
  const certificate = loadCellCertificatesRepo.current() ?? null
  const cal = validity(calibration?.dueDate)
  const cert = validity(certificate?.validUntil)
  const policy = getPolicy()
  const applies = getHardware().driverKind === 'modbus'
  const bad = (state: ValidityState): boolean => state === 'overdue' || state === 'missing'
  return {
    calibration,
    certificate: certificate ? withoutPath(certificate) : null,
    calibrationState: cal.state,
    certificateState: cert.state,
    daysToCalibrationDue: cal.days,
    daysToCertificateDue: cert.days,
    policy,
    applies,
    blocking: applies && policy.enforcement === 'block' && (bad(cal.state) || bad(cert.state))
  }
}

function withoutPath<T extends { filePath: string | null }>(c: T): Omit<T, 'filePath'> {
  const { filePath: _filePath, ...rest } = c
  return rest
}

/** Called before every test on the real machine. */
export function assertCalibrationAllowsTest(): void {
  const status = getStatus()
  if (!status.blocking) return
  const reasons: string[] = []
  if (status.calibrationState === 'missing') reasons.push('the load cell has never been calibrated')
  if (status.calibrationState === 'overdue') reasons.push('the load-cell calibration is overdue')
  if (status.certificateState === 'missing') reasons.push('no accredited load-cell certificate is recorded')
  if (status.certificateState === 'overdue') reasons.push('the accredited load-cell certificate has expired')
  throw new CommandError(
    ErrorCode.CALIBRATION_REQUIRED,
    `Testing is blocked: ${reasons.join(' and ')}. An administrator must update it in Settings → Calibration.`
  )
}

/** What a new test run records for traceability. */
export function currentReferences(): { calibrationId: number | null; loadCellCertificateId: number | null } {
  return {
    calibrationId: calibrationsRepo.active()?.id ?? null,
    loadCellCertificateId: loadCellCertificatesRepo.current()?.id ?? null
  }
}

// ---------------------------------------------------------------------------
// Capturing and saving a calibration
// ---------------------------------------------------------------------------

/** Averages the raw (uncorrected) load over a short window while the machine is still. */
export function capture(durationMs = DEFAULT_CAPTURE_MS): Promise<CalibrationCapture> {
  const hardware = getHardware()
  const snapshot = hardware.getSnapshot()
  if (!snapshot.connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  if (snapshot.phase !== 'idle') throw invalid('Stop the machine before capturing a calibration point.')
  const window = Math.min(Math.max(Number(durationMs) || DEFAULT_CAPTURE_MS, 500), 10000)

  return new Promise((resolve, reject) => {
    const samples: number[] = []
    const onFrame = (frame: TelemetryFrame): void => {
      samples.push(frame.loadRawN)
    }
    hardware.on('telemetry', onFrame)
    setTimeout(() => {
      hardware.off('telemetry', onFrame)
      if (samples.length < 3) {
        reject(invalid('No readings came from the load cell. Check the machine connection.'))
        return
      }
      const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length
      const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (samples.length - 1)
      const stdDev = Math.sqrt(variance)
      resolve({
        rawN: round(mean, 3),
        stdDevN: round(stdDev, 3),
        samples: samples.length,
        // A swinging weight or a vibrating frame shows up as spread.
        stable: stdDev <= Math.max(0.2, Math.abs(mean) * 0.002)
      })
    }, window)
  })
}

export function save(draft: CalibrationDraft, performedBy: string): Calibration {
  const points = Array.isArray(draft?.points) ? draft.points : []
  if (points.length < 2) throw invalid('Capture at least two points: zero and one reference load.')
  if (points.length > MAX_POINTS) throw invalid(`Use at most ${MAX_POINTS} points.`)
  for (const [i, p] of points.entries()) {
    if (!Number.isFinite(p.referenceN) || p.referenceN < 0) {
      throw invalid(`Point ${i + 1}: the reference load must be 0 or more.`)
    }
    if (!Number.isFinite(p.rawN)) throw invalid(`Point ${i + 1}: capture a reading first.`)
  }
  const references = new Set(points.map((p) => p.referenceN))
  if (references.size < 2) throw invalid('Use at least two different reference loads.')

  let fit
  try {
    fit = fitCalibration(points)
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error))
  }
  const policy = getPolicy()
  const passed = fit.maxErrorN <= policy.maxPermissibleErrorN
  const record: Omit<Calibration, 'id'> = {
    performedAt: new Date().toISOString(),
    performedBy,
    gain: fit.gain,
    offset: fit.offset,
    points: fit.points,
    maxErrorN: fit.maxErrorN,
    maxPermissibleErrorN: policy.maxPermissibleErrorN,
    passed,
    referenceDevice: String(draft.referenceDevice ?? '').trim().slice(0, 80),
    referenceCertificateNo: String(draft.referenceCertificateNo ?? '').trim().slice(0, 80),
    dueDate: addMonths(today(), policy.intervalMonths),
    notes: String(draft.notes ?? '').trim().slice(0, 500)
  }
  const id = calibrationsRepo.insert(record)
  if (passed) {
    getHardware().setLoadCalibration(record.gain, record.offset)
    log.info(`Load cell calibrated by ${performedBy}: gain ${record.gain}, offset ${record.offset}, max error ${record.maxErrorN} N`)
  } else {
    log.warn(`Calibration by ${performedBy} failed: max error ${record.maxErrorN} N > ${policy.maxPermissibleErrorN} N; not applied`)
  }
  return { id, ...record }
}

// ---------------------------------------------------------------------------
// Accredited load-cell certificate
// ---------------------------------------------------------------------------

export function saveCertificate(draft: CertificateDraft): CalibrationStatus {
  const text = (value: unknown, max = 80): string => String(value ?? '').trim().slice(0, max)
  const labName = text(draft?.labName, 120)
  const certificateNo = text(draft?.certificateNo)
  if (!labName) throw invalid('Enter the calibration laboratory.')
  if (!certificateNo) throw invalid('Enter the certificate number.')
  if (!isDate(String(draft.calibratedOn))) throw invalid('Enter the calibration date.')
  if (!isDate(String(draft.validUntil))) throw invalid('Enter the date the certificate is valid until.')
  if (draft.validUntil <= draft.calibratedOn) {
    throw invalid('"Valid until" must be after the calibration date.')
  }
  loadCellCertificatesRepo.insert({
    labName,
    accreditationNo: text(draft.accreditationNo),
    certificateNo,
    loadCellSerial: text(draft.loadCellSerial),
    calibratedOn: draft.calibratedOn,
    validUntil: draft.validUntil,
    uncertainty: text(draft.uncertainty),
    filePath: null
  })
  log.info(`Load-cell certificate ${certificateNo} recorded (valid until ${draft.validUntil})`)
  return getStatus()
}

/** Copies the scanned certificate into the app's data folder and links it. */
export function attachCertificateFile(sourcePath: string): CalibrationStatus {
  const current = loadCellCertificatesRepo.current()
  if (!current) throw invalid('Save the certificate details first, then attach the file.')
  if (!existsSync(sourcePath)) throw invalid('That file no longer exists.')
  const dir = join(app.getPath('userData'), 'certificates')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${current.id}-${basename(sourcePath).replace(/[^\w.-]+/g, '_')}`)
  copyFileSync(sourcePath, target)
  loadCellCertificatesRepo.setFile(current.id, target)
  return getStatus()
}

export function certificateFilePath(): string {
  const current = loadCellCertificatesRepo.current()
  if (!current?.filePath || !existsSync(current.filePath)) {
    throw invalid('No certificate file is attached.')
  }
  return current.filePath
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
