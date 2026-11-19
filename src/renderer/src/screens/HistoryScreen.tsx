import { useCallback, useEffect, useState } from 'react'
import type { ModelConfig, TestRunDetail, TestRunQuery, TestRunSummary } from '@shared/types'
import { formatResult } from '@shared/analysis'
import { api, unwrap } from '../api/client'
import { Header } from '../components/Header'
import { Icon } from '../components/Icons'
import { critical, information } from '../components/MessageBox'
import { plotPng, PlotView } from '../components/Plot'

const PAGE_SIZE = 12

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

/** Past tests: search, look at the graph and results, reprint the report. */
export default function HistoryScreen({ onHome }: { onHome: () => void }): JSX.Element {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [filters, setFilters] = useState<TestRunQuery>({})
  const [applied, setApplied] = useState<TestRunQuery>({})
  const [page, setPage] = useState(0)
  const [runs, setRuns] = useState<TestRunSummary[]>([])
  const [total, setTotal] = useState(0)
  const [detail, setDetail] = useState<TestRunDetail | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.models.list().then((r) => r.ok && setModels(r.data))
  }, [])

  const load = useCallback(async () => {
    const result = await api.reports.search({ ...applied, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
    if (!result.ok) return
    setRuns(result.data.runs)
    setTotal(result.data.total)
  }, [applied, page])

  useEffect(() => {
    void load()
  }, [load])

  const select = async (runId: number): Promise<void> => {
    const result = await api.reports.run(runId)
    if (result.ok) setDetail(result.data)
  }

  const reprint = async (): Promise<void> => {
    if (!detail || busy) return
    setBusy(true)
    try {
      const png = plotPng({ model: detail.model, n: detail.samples, n1: null, n2: null })
      const files = await unwrap(api.reports.generate(png, detail.run.id))
      const name = files.pdfPath.split(/[\\/]/).pop()?.replace(/\.pdf$/, '') ?? ''
      await information('Report saved', `Report generated:\n${name} (.xlsx, .pdf, .json)`)
      void load()
    } catch (error) {
      await critical('Report', `Could not generate the report: ${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const search = (): void => {
    setPage(0)
    setApplied({ ...filters })
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const r = detail?.run.results

  return (
    <div className="screen">
      <Header title="Test history">
        <button className="header-btn" onClick={onHome} data-testid="h-home">
          <Icon name="homing" size={16} /> HOME
        </button>
      </Header>
      <div className="body" style={{ gridTemplateColumns: '1fr 430px', gridTemplateRows: 'auto 1fr' }}>
        <div className="card" style={{ padding: '10px 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 150px 150px auto auto', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              placeholder="Part-No contains…"
              value={filters.partNo ?? ''}
              onChange={(e) => setFilters({ ...filters, partNo: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              data-testid="h-partno"
            />
            <select
              className="input"
              value={filters.modelId ?? ''}
              onChange={(e) => setFilters({ ...filters, modelId: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">All models</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="date"
              value={filters.fromDate ?? ''}
              onChange={(e) => setFilters({ ...filters, fromDate: e.target.value || undefined })}
              title="From"
            />
            <input
              className="input"
              type="date"
              value={filters.toDate ?? ''}
              onChange={(e) => setFilters({ ...filters, toDate: e.target.value || undefined })}
              title="To"
            />
            <button className="btn" onClick={search} data-testid="h-search">
              SEARCH
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setFilters({})
                setPage(0)
                setApplied({})
              }}
            >
              CLEAR
            </button>
          </div>
        </div>

        <div className="card" style={{ gridRow: '1 / span 2' }}>
          <div className="card-title">
            <Icon name="report" size={16} /> {detail ? `${detail.run.modelName ?? ''} · ${detail.run.partNo ?? ''}` : 'Select a test'}
          </div>
          {detail ? (
            <>
              <div style={{ height: 330, display: 'flex' }}>
                <PlotView data={{ model: detail.model, n: detail.samples, n1: null, n2: null }} testId="h-graph" />
              </div>
              <div className="kv" style={{ marginTop: 10 }}>
                <label>Date</label>
                <div className="value">{when(detail.run.endedAt ?? detail.run.startedAt)}</div>
                <label>Operator</label>
                <div className="value">{detail.run.employeeName ?? ''}</div>
                <label>Avg up / down (N)</label>
                <div className="value" data-testid="h-avg">
                  {r ? `${formatResult(r.avgUpN)} / ${formatResult(r.avgDownN)}` : '—'}
                </div>
                <label>Mean / hysteresis (N)</label>
                <div className="value">{r ? `${formatResult(r.meanN)} / ${formatResult(r.hysteresisN)}` : '—'}</div>
              </div>
              <div className="row" style={{ marginTop: 'auto', paddingTop: 10 }}>
                <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => void reprint()} data-testid="h-reprint">
                  <Icon name="report" /> REPRINT REPORT
                </button>
                <button className="btn ghost" onClick={() => void api.reports.openFolder(detail.run.id)}>
                  OPEN FOLDER
                </button>
              </div>
            </>
          ) : (
            <div className="note">Choose a test in the list to see its graph and results and to reprint its report.</div>
          )}
        </div>

        <div className="card" style={{ minHeight: 0 }}>
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>
              {total} test{total === 1 ? '' : 's'}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn ghost" style={{ height: 30 }} disabled={page === 0} onClick={() => setPage(page - 1)}>
                ‹
              </button>
              <span style={{ textTransform: 'none' }}>
                {page + 1} / {pages}
              </span>
              <button className="btn ghost" style={{ height: 30 }} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                ›
              </button>
            </span>
          </div>
          <table className="table" data-testid="h-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Part-No</th>
                <th>Model</th>
                <th>Operator</th>
                <th>Result</th>
                <th style={{ textAlign: 'right' }}>Mean (N)</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className={detail?.run.id === run.id ? 'selected' : ''}
                  onClick={() => void select(run.id)}
                  data-testid="h-row"
                >
                  <td>{when(run.startedAt)}</td>
                  <td>{run.partNo}</td>
                  <td>{run.modelName}</td>
                  <td>{run.employeeName}</td>
                  <td>{run.resultStatus}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{run.results ? formatResult(run.results.meanN) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 && <div className="note" style={{ padding: 10 }}>No tests match.</div>}
        </div>
      </div>
    </div>
  )
}
