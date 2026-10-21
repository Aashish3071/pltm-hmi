import { useCallback, useEffect, useState } from 'react'
import { fitCalibration, kgToNewtons } from '@shared/calibration'
import type {
  Calibration,
  CalibrationPolicy,
  CalibrationStatus,
  CertificateDraft,
  HardwareDriver,
  ValidityState
} from '@shared/types'
import { api } from '../../api/client'
import { useMachineStore } from '../../state/machineStore'
import { toast } from '../../state/toastStore'

interface Props {
  driver: HardwareDriver
}

type Unit = 'kg' | 'N'

interface Row {
  key: number
  value: string
  unit: Unit
  rawN: number | null
  stable: boolean | null
}

const MAX_ROWS = 11
let nextKey = 1

function newRow(value = '', unit: Unit = 'kg'): Row {
  return { key: nextKey++, value, unit, rawN: null, stable: null }
}

function referenceN(row: Row): number | null {
  if (row.value.trim() === '') return null
  const value = Number(row.value)
  if (!Number.isFinite(value) || value < 0) return null
  return row.unit === 'kg' ? kgToNewtons(value) : value
}

const STATE_TEXT: Record<ValidityState, string> = {
  ok: 'VALID',
  'due-soon': 'DUE SOON',
  overdue: 'OVERDUE',
  missing: 'NOT RECORDED'
}

function StateBadge({ state }: { state: ValidityState }): JSX.Element {
  return <span className={`state-badge ${state}`}>{STATE_TEXT[state]}</span>
}

export default function CalibrationPanel({ driver }: Props): JSX.Element {
  const [status, setStatus] = useState<CalibrationStatus | null>(null)
  const [history, setHistory] = useState<Calibration[]>([])

  const reload = useCallback(async (): Promise<void> => {
    const [s, h] = await Promise.all([api.calibration.status(), api.calibration.history()])
    if (s.ok) setStatus(s.data)
    if (h.ok) setHistory(h.data)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className="calibration-grid">
      <div className="calibration-col">
        <StatusPanel status={status} />
        <NewCalibrationPanel
          simulator={driver === 'simulator'}
          maxPermissibleErrorN={status?.policy.maxPermissibleErrorN ?? 1}
          onSaved={reload}
        />
      </div>
      <div className="calibration-col">
        <CertificatePanel status={status} onChange={setStatus} />
        {status && <PolicyPanel policy={status.policy} onSaved={reload} />}
        <HistoryPanel history={history} />
      </div>
    </div>
  )
}

function StatusPanel({ status }: { status: CalibrationStatus | null }): JSX.Element {
  const loadN = useMachineStore((s) => s.loadN)
  const loadRawN = useMachineStore((s) => s.loadRawN)
  const cal = status?.calibration
  const cert = status?.certificate
  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#9878;</span> LOAD-CELL STATUS
      </div>
      <div className="field-row">
        <label>LIVE LOAD (calibrated)</label>
        <div className="readonly-value">{loadN.toFixed(2)} N</div>
      </div>
      <div className="field-row">
        <label>RAW READING</label>
        <div className="readonly-value">{loadRawN.toFixed(2)} N</div>
      </div>
      <div className="status-lines">
        <div>
          <b>Calibration:</b> {status && <StateBadge state={status.calibrationState} />}{' '}
          {cal
            ? `${cal.performedAt.slice(0, 10)} by ${cal.performedBy}; largest error ${cal.maxErrorN.toFixed(2)} N; due ${cal.dueDate}`
            : 'never calibrated'}
        </div>
        <div>
          <b>Accredited certificate:</b> {status && <StateBadge state={status.certificateState} />}{' '}
          {cert ? `${cert.certificateNo} (${cert.labName}), valid until ${cert.validUntil}` : 'none recorded'}
        </div>
      </div>
      {status && !status.applies && (
        <div className="hint">
          Simulator: due dates are not enforced. On the real machine they are, as set in the policy.
        </div>
      )}
      {status?.blocking && <div className="hint warn">Testing is blocked until this is fixed.</div>}
    </div>
  )
}

function NewCalibrationPanel({
  simulator,
  maxPermissibleErrorN,
  onSaved
}: {
  simulator: boolean
  maxPermissibleErrorN: number
  onSaved: () => Promise<void>
}): JSX.Element {
  const [rows, setRows] = useState<Row[]>(() => [newRow('0', 'N'), newRow(), newRow()])
  const [capturing, setCapturing] = useState<number | null>(null)
  const [referenceDevice, setReferenceDevice] = useState('')
  const [referenceCertificateNo, setReferenceCertificateNo] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const update = (key: number, patch: Partial<Row>): void =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const capture = async (row: Row): Promise<void> => {
    const ref = referenceN(row)
    if (ref === null) {
      toast.error('Enter the reference load for this point first.')
      return
    }
    setCapturing(row.key)
    try {
      // On the simulator the reference load is "hung" on the cell automatically.
      if (simulator) {
        await api.calibration.simulateLoad(ref)
        await new Promise((r) => setTimeout(r, 300))
      }
      const result = await api.calibration.capture()
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      update(row.key, { rawN: result.data.rawN, stable: result.data.stable })
      if (!result.data.stable) {
        toast.error('The reading was not steady. Let the weight stop swinging and capture again.')
      }
    } finally {
      if (simulator) await api.calibration.simulateLoad(null)
      setCapturing(null)
    }
  }

  const captured = rows
    .map((r) => ({ ref: referenceN(r), raw: r.rawN }))
    .filter((p): p is { ref: number; raw: number } => p.ref !== null && p.raw !== null)

  const preview = ((): ReturnType<typeof fitCalibration> | { error: string } | null => {
    if (captured.length < 2) return null
    try {
      return fitCalibration(captured.map((p) => ({ referenceN: p.ref, rawN: p.raw })))
    } catch (error) {
      return { error: (error as Error).message }
    }
  })()

  const save = async (): Promise<void> => {
    setSaving(true)
    const result = await api.calibration.save({
      points: captured.map((p) => ({ referenceN: p.ref, rawN: p.raw })),
      referenceDevice,
      referenceCertificateNo,
      notes
    })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    if (result.data.passed) {
      toast.success(`Calibration saved and applied. Next due ${result.data.dueDate}.`)
      setRows([newRow('0', 'N'), newRow(), newRow()])
    } else {
      toast.error(
        `Calibration failed: largest error ${result.data.maxErrorN} N is above ${result.data.maxPermissibleErrorN} N. It was recorded but not applied.`
      )
    }
    await onSaved()
  }

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#128208;</span> NEW CALIBRATION
      </div>
      <ol className="steps">
        <li>Remove all load from the load cell, then CAPTURE point 1 (zero).</li>
        <li>Hang each reference weight, enter its value, wait until it is still, then CAPTURE.</li>
        <li>Use at least 3 points spread over the working range (e.g. 0, 5, 7, 10 kg). Check the errors, then SAVE.</li>
      </ol>
      {simulator && (
        <div className="hint">Simulator: CAPTURE applies the entered reference load automatically.</div>
      )}
      <table className="cal-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Reference load</th>
            <th>Raw reading</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key}>
              <td>{i + 1}</td>
              <td>
                <div className="ref-input">
                  <input
                    inputMode="decimal"
                    aria-label={`Reference load ${i + 1}`}
                    value={row.value}
                    onChange={(e) => {
                      if (/^\d*\.?\d*$/.test(e.target.value)) {
                        update(row.key, { value: e.target.value, rawN: null, stable: null })
                      }
                    }}
                  />
                  <select
                    aria-label={`Unit ${i + 1}`}
                    value={row.unit}
                    onChange={(e) => update(row.key, { unit: e.target.value as Unit, rawN: null, stable: null })}
                  >
                    <option value="kg">kg</option>
                    <option value="N">N</option>
                  </select>
                </div>
              </td>
              <td className={row.stable === false ? 'unstable' : ''}>
                {row.rawN === null ? '—' : `${row.rawN.toFixed(2)} N${row.stable === false ? ' (unsteady)' : ''}`}
              </td>
              <td className="row-actions">
                <button
                  className="btn small"
                  disabled={capturing !== null}
                  onClick={() => void capture(row)}
                >
                  {capturing === row.key ? 'READING…' : 'CAPTURE'}
                </button>
                {rows.length > 2 && (
                  <button
                    className="btn small"
                    title="Remove this point"
                    disabled={capturing !== null}
                    onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                  >
                    &#10005;
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn small"
        style={{ marginTop: 6 }}
        disabled={rows.length >= MAX_ROWS}
        onClick={() => setRows((prev) => [...prev, newRow()])}
      >
        + ADD POINT
      </button>

      {preview && 'error' in preview && <div className="hint warn">{preview.error}</div>}
      {preview && !('error' in preview) && (
        <div className="fit-preview">
          <div>
            Correction: load = {preview.gain.toFixed(5)} × raw {preview.offset >= 0 ? '+' : '−'}{' '}
            {Math.abs(preview.offset).toFixed(3)} N
          </div>
          <table className="cal-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Corrected</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {preview.points.map((p, i) => (
                <tr key={i}>
                  <td>{p.referenceN.toFixed(2)} N</td>
                  <td>{p.correctedN.toFixed(2)} N</td>
                  <td className={Math.abs(p.errorN) > maxPermissibleErrorN ? 'unstable' : ''}>
                    {p.errorN >= 0 ? '+' : ''}
                    {p.errorN.toFixed(3)} N
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={preview.maxErrorN <= maxPermissibleErrorN ? 'fit-pass' : 'fit-fail'}>
            Largest error {preview.maxErrorN.toFixed(3)} N — limit {maxPermissibleErrorN} N —{' '}
            {preview.maxErrorN <= maxPermissibleErrorN ? 'PASS' : 'FAIL'}
          </div>
        </div>
      )}

      <div className="field-row" style={{ marginTop: 8 }}>
        <label>REFERENCE WEIGHTS / DEVICE</label>
        <input value={referenceDevice} maxLength={80} onChange={(e) => setReferenceDevice(e.target.value)} />
      </div>
      <div className="field-row">
        <label>THEIR CERTIFICATE NO.</label>
        <input
          value={referenceCertificateNo}
          maxLength={80}
          onChange={(e) => setReferenceCertificateNo(e.target.value)}
        />
      </div>
      <div className="field-row">
        <label>NOTES</label>
        <input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <button
        className="btn yellow small"
        style={{ marginTop: 6 }}
        disabled={saving || !preview || 'error' in preview}
        onClick={() => void save()}
      >
        {saving ? 'SAVING…' : 'SAVE CALIBRATION'}
      </button>
    </div>
  )
}

function CertificatePanel({
  status,
  onChange
}: {
  status: CalibrationStatus | null
  onChange: (status: CalibrationStatus) => void
}): JSX.Element {
  const current = status?.certificate
  const empty: CertificateDraft = {
    labName: '',
    accreditationNo: '',
    certificateNo: '',
    loadCellSerial: '',
    calibratedOn: '',
    validUntil: '',
    uncertainty: ''
  }
  const [draft, setDraft] = useState<CertificateDraft>(empty)

  const field = (key: keyof CertificateDraft, label: string, type = 'text'): JSX.Element => (
    <div className="field-row">
      <label>{label}</label>
      <input
        type={type}
        aria-label={label}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  )

  const save = async (): Promise<void> => {
    const result = await api.calibration.saveCertificate(draft)
    if (result.ok) {
      onChange(result.data)
      setDraft(empty)
      toast.success('Load-cell certificate recorded.')
    } else {
      toast.error(result.message)
    }
  }

  const attach = async (): Promise<void> => {
    const result = await api.calibration.attachCertificate()
    if (result.ok) onChange(result.data)
    else toast.error(result.message)
  }

  const open = async (): Promise<void> => {
    const result = await api.calibration.openCertificate()
    if (!result.ok) toast.error(result.message)
  }

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#128220;</span> ACCREDITED LOAD-CELL CERTIFICATE
      </div>
      {current ? (
        <div className="status-lines">
          <div>
            <b>{current.certificateNo}</b> — {current.labName}
            {current.accreditationNo && ` (accreditation ${current.accreditationNo})`}
          </div>
          <div>
            Calibrated {current.calibratedOn}, valid until {current.validUntil}
            {current.loadCellSerial && `; load cell s/n ${current.loadCellSerial}`}
            {current.uncertainty && `; uncertainty ${current.uncertainty}`}
          </div>
          <div>
            File: {current.fileName ?? 'not attached'}{' '}
            <button className="btn small" onClick={() => void attach()}>
              {current.fileName ? 'REPLACE FILE' : 'ATTACH FILE'}
            </button>{' '}
            {current.fileName && (
              <button className="btn small" onClick={() => void open()}>
                OPEN
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="hint">
          Record the NABL / ISO 17025 calibration certificate supplied with the load cell.
        </div>
      )}
      <div className="section-subtitle">{current ? 'Record a new certificate' : 'Certificate details'}</div>
      {field('labName', 'CALIBRATION LAB')}
      {field('accreditationNo', 'LAB ACCREDITATION NO.')}
      {field('certificateNo', 'CERTIFICATE NO.')}
      {field('loadCellSerial', 'LOAD-CELL SERIAL NO.')}
      {field('calibratedOn', 'CALIBRATED ON', 'date')}
      {field('validUntil', 'VALID UNTIL', 'date')}
      {field('uncertainty', 'UNCERTAINTY')}
      <button className="btn yellow small" style={{ marginTop: 6 }} onClick={() => void save()}>
        SAVE CERTIFICATE
      </button>
    </div>
  )
}

function PolicyPanel({
  policy,
  onSaved
}: {
  policy: CalibrationPolicy
  onSaved: () => Promise<void>
}): JSX.Element {
  const [enforcement, setEnforcement] = useState(policy.enforcement)
  const [interval, setIntervalMonths] = useState(String(policy.intervalMonths))
  const [mpe, setMpe] = useState(String(policy.maxPermissibleErrorN))

  const save = async (): Promise<void> => {
    const result = await api.calibration.setPolicy({
      enforcement,
      intervalMonths: Number(interval),
      maxPermissibleErrorN: Number(mpe)
    })
    if (result.ok) {
      toast.success('Calibration policy saved.')
      await onSaved()
    } else {
      toast.error(result.message)
    }
  }

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#128197;</span> POLICY
      </div>
      <div className="field-row">
        <label>WHEN OVERDUE</label>
        <select value={enforcement} onChange={(e) => setEnforcement(e.target.value as 'warn' | 'block')}>
          <option value="warn">Warn only</option>
          <option value="block">Block tests</option>
        </select>
      </div>
      <div className="field-row">
        <label>RECALIBRATE EVERY (months)</label>
        <input inputMode="numeric" value={interval} onChange={(e) => setIntervalMonths(e.target.value)} />
      </div>
      <div className="field-row">
        <label>MAX PERMISSIBLE ERROR (N)</label>
        <input inputMode="decimal" value={mpe} onChange={(e) => setMpe(e.target.value)} />
      </div>
      <button className="btn yellow small" style={{ marginTop: 6 }} onClick={() => void save()}>
        SAVE POLICY
      </button>
    </div>
  )
}

function HistoryPanel({ history }: { history: Calibration[] }): JSX.Element {
  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#128337;</span> HISTORY
      </div>
      {history.length === 0 ? (
        <div className="hint">No calibrations yet.</div>
      ) : (
        <table className="cal-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>By</th>
              <th>Points</th>
              <th>Largest error</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {history.map((c) => (
              <tr key={c.id}>
                <td>{c.performedAt.slice(0, 10)}</td>
                <td>{c.performedBy}</td>
                <td>{c.points.length}</td>
                <td>{c.maxErrorN.toFixed(3)} N</td>
                <td className={c.passed ? 'fit-pass' : 'fit-fail'}>{c.passed ? 'PASS' : 'FAIL'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
