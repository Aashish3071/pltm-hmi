import { useCallback, useEffect, useState } from 'react'
import { HardwareStatus, type ModelConfig, type TestRunQuery, type TestRunSummary } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'
import GraphPanel, { loadAxisMax, renderGraphPng } from '../Home/GraphPanel'

interface Props {
  onHome: () => void
}

type Point = { loadN: number; heightMm: number }

interface Chart {
  run: TestRunSummary
  points: Point[]
  envelope: Point[]
  maxHeightMm: number
}

const PAGE_SIZE = 50
/** How a run can end, as stored by finishRun. ABORTED: stopped by RESET, logout, a crash or power loss. */
const COMPLETED = 'COMPLETED'
const RESULTS: string[] = [
  COMPLETED,
  'ABORTED',
  HardwareStatus.DISCONNECTED,
  HardwareStatus.OVERLOAD,
  HardwareStatus.EMERGENCY_PRESSED,
  HardwareStatus.OVER_TRAVEL,
  HardwareStatus.SERVO_ERROR,
  HardwareStatus.SERVO_OFF
]

function resultLabel(status: string | null): string {
  return status ?? '-'
}

/** Stored timestamps are UTC ("YYYY-MM-DD HH:MM:SS"); show local time. */
function localTime(utc: string | null): string {
  if (!utc) return '-'
  const date = new Date(`${utc.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? utc : date.toLocaleString()
}

function fixed(value: number | null, decimals = 1): string {
  return value === null || value === undefined ? '-' : value.toFixed(decimals)
}

export default function HistoryScreen({ onHome }: Props): JSX.Element {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [filters, setFilters] = useState<TestRunQuery>({})
  const [applied, setApplied] = useState<TestRunQuery>({})
  const [page, setPage] = useState(0)
  const [runs, setRuns] = useState<TestRunSummary[]>([])
  const [total, setTotal] = useState(0)
  const [chart, setChart] = useState<Chart | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.models.list().then((result) => {
      if (result.ok) setModels(result.data)
    })
  }, [])

  const select = useCallback(async (runId: number): Promise<void> => {
    const result = await api.reports.runPoints(runId)
    if (result.ok) setChart(result.data)
    else toast.error(result.message)
  }, [])

  useEffect(() => {
    void (async () => {
      const result = await api.reports.search({ ...applied, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      setRuns(result.data.runs)
      setTotal(result.data.total)
      if (result.data.runs[0]) void select(result.data.runs[0].id)
      else setChart(null)
    })()
  }, [applied, page, select])

  const search = (): void => {
    setPage(0)
    setApplied({ ...filters })
  }

  const clear = (): void => {
    setFilters({})
    setPage(0)
    setApplied({})
  }

  const saveReport = async (): Promise<void> => {
    if (!chart) return
    setBusy(true)
    try {
      const png = renderGraphPng({
        points: chart.points,
        envelope: chart.envelope,
        maxHeightMm: chart.maxHeightMm,
        maxLoadN: loadAxisMax(chart.envelope)
      })
      const result = await api.reports.generate(png, chart.run.id)
      if (result.ok) {
        const runId = chart.run.id
        toast.success(`Report and certificate ${result.data.certificateNo} saved.`, {
          label: 'OPEN FOLDER',
          run: () => void api.reports.openFolder(runId)
        })
        // The run now has a certificate number and report path.
        setRuns((list) =>
          list.map((r) =>
            r.id === runId ? { ...r, certificateNo: result.data.certificateNo, reportPath: result.data.excelPath } : r
          )
        )
      } else {
        toast.error(result.message)
      }
    } finally {
      setBusy(false)
    }
  }

  const set = (patch: Partial<TestRunQuery>): void => setFilters({ ...filters, ...patch })
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const selected = chart?.run

  return (
    <div className="history">
      <div className="history-left">
        <GraphPanel
          envelope={chart?.envelope ?? []}
          points={chart?.points ?? []}
          maxHeightMm={chart?.maxHeightMm ?? 1}
          maxLoadN={loadAxisMax(chart?.envelope ?? [])}
        />
        <div className="history-footer">
          <button className="btn yellow" onClick={onHome}>
            HOME
          </button>
        </div>
      </div>

      <div className="history-right">
        <div className="panel orange history-filters">
          <div className="section-title">
            <span className="glyph">&#128269;</span> TEST HISTORY
          </div>
          <div className="filter-grid">
            <label>
              PART-NO
              <input
                value={filters.partNo ?? ''}
                placeholder="any"
                onChange={(e) => set({ partNo: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
            </label>
            <label>
              MODEL
              <select
                value={filters.modelId ?? ''}
                onChange={(e) => set({ modelId: e.target.value ? Number(e.target.value) : undefined })}
              >
                <option value="">All models</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              RESULT
              <select
                value={filters.resultStatus ?? ''}
                onChange={(e) => set({ resultStatus: e.target.value || undefined })}
              >
                <option value="">All results</option>
                {RESULTS.map((r) => (
                  <option key={r} value={r}>
                    {resultLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              FROM
              <input type="date" value={filters.fromDate ?? ''} onChange={(e) => set({ fromDate: e.target.value || undefined })} />
            </label>
            <label>
              TO
              <input type="date" value={filters.toDate ?? ''} onChange={(e) => set({ toDate: e.target.value || undefined })} />
            </label>
            <div className="filter-actions">
              <button className="btn yellow small" onClick={search}>
                SEARCH
              </button>
              <button className="btn small" onClick={clear}>
                CLEAR
              </button>
            </div>
          </div>
        </div>

        <div className="panel orange history-detail">
          {selected ? (
            <>
              <div className="detail-grid">
                <span>Part-No</span>
                <b>{selected.partNo || '-'}</b>
                <span>Up / down cycle</span>
                <b>
                  {fixed(selected.upCycleSec)} s / {fixed(selected.downCycleSec)} s
                </b>
                <span>Ended</span>
                <b>{localTime(selected.endedAt)}</b>
                <span>Certificate</span>
                <b>{selected.certificateNo ?? 'not issued yet'}</b>
              </div>
              <div className="row-actions" style={{ marginTop: 8 }}>
                <button className="btn yellow small" disabled={busy} onClick={() => void saveReport()}>
                  {busy ? 'SAVING…' : selected.certificateNo ? 'REPRINT REPORT' : 'SAVE REPORT'}
                </button>
                <button className="btn small" onClick={() => void api.reports.openFolder(selected.id)}>
                  OPEN FOLDER
                </button>
              </div>
              {selected.resultStatus !== COMPLETED && (
                <div className="hint warn" style={{ marginTop: 6 }}>
                  This test did not complete ({resultLabel(selected.resultStatus)}); its report records
                  that.
                </div>
              )}
            </>
          ) : (
            <div className="hint">Select a test to see its graph and save its report.</div>
          )}
        </div>

        <div className="panel orange history-list">
          <div className="history-count">
            {total === 0
              ? 'No tests match.'
              : `${total} test${total === 1 ? '' : 's'} found${pages > 1 ? ` — page ${page + 1} of ${pages}` : ''}`}
          </div>
          <div className="history-table-wrap">
            <table className="cal-table history-table">
              <thead>
                <tr>
                  <th>DATE</th>
                  <th>PART-NO</th>
                  <th>MODEL</th>
                  <th>OPERATOR</th>
                  <th>RESULT</th>
                  <th>MAX (N)</th>
                  <th>CERTIFICATE</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className={r.id === selected?.id ? 'selected' : ''}
                    onClick={() => void select(r.id)}
                  >
                    <td>{localTime(r.startedAt)}</td>
                    <td>{r.partNo || '-'}</td>
                    <td>{r.modelName ?? '-'}</td>
                    <td>{r.employeeName ?? '-'}</td>
                    <td className={r.resultStatus === COMPLETED ? 'fit-pass' : 'unstable'}>{resultLabel(r.resultStatus)}</td>
                    <td>{fixed(r.maxLoadN)}</td>
                    <td>{r.certificateNo ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="row-actions" style={{ marginTop: 6 }}>
              <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>
                &#9664; NEWER
              </button>
              <button className="btn small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                OLDER &#9654;
              </button>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
