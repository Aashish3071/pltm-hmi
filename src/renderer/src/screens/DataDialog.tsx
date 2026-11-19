import { useEffect, useState } from 'react'
import type { BackupInfo, BackupStatus, IpcResult } from '@shared/types'
import { api } from '../api/client'
import { Icon } from '../components/Icons'

const KIND_LABEL: Record<BackupInfo['kind'], string> = {
  auto: 'Automatic',
  manual: 'Manual',
  'pre-restore': 'Before a restore'
}
/** A backup older than this is flagged; automatic backups run daily. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** DATA: backups of users, models, settings and test records, and restore. */
export default function DataDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)

  useEffect(() => {
    void api.backup.status().then((r) => (r.ok ? setStatus(r.data) : setMessage({ ok: false, text: r.message })))
  }, [])

  const run = async (action: () => Promise<IpcResult<BackupStatus>>, done: string): Promise<void> => {
    setBusy(true)
    const result = await action()
    setBusy(false)
    if (result.ok) {
      setStatus(result.data)
      setMessage({ ok: true, text: done })
    } else setMessage({ ok: false, text: result.message })
  }

  const pickRestore = async (): Promise<void> => {
    const result = await api.backup.pickRestore()
    if (!result.ok) setMessage({ ok: false, text: result.message })
    else if (result.data) setRestoring(result.data)
  }

  const restore = async (backup: BackupInfo): Promise<void> => {
    setBusy(true)
    const result = await api.backup.restore(backup.path)
    if (result.ok) setMessage({ ok: true, text: 'Backup restored. The application is restarting…' })
    else {
      setBusy(false)
      setRestoring(null)
      setMessage({ ok: false, text: result.message })
    }
  }

  const stale = status && (!status.lastBackupAt || Date.now() - Date.parse(status.lastBackupAt) > STALE_MS)

  return (
    <div className="modal-backdrop">
      <div className="dialog sys" role="dialog" aria-label="DATA" data-testid="data-dialog">
        <div className="dialog-head">
          <Icon name="report" size={18} /> DATA — backup and restore
          <button className="x" onClick={onClose} title="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dialog-body">
          {!status ? (
            'Loading…'
          ) : (
            <>
              <p className="note" style={{ color: stale || status.lastError ? 'var(--red)' : undefined }} data-testid="backup-summary">
                {status.lastError
                  ? `The last backup failed: ${status.lastError}`
                  : status.lastBackupAt
                    ? `Last backup: ${when(status.lastBackupAt)}.`
                    : 'No backup has been made yet.'}{' '}
                A backup is made automatically every day and holds all users, models, settings and test records.
              </p>
              <div className="sys">
                <div className="grid">
                  <span>Backup folder</span>
                  <div className="value" style={{ justifyContent: 'flex-start', fontSize: 12, gridColumn: 'span 3' }} title={status.dir}>
                    {status.dir}
                  </div>
                </div>
              </div>
              <p className="note">
                Choose a folder on another drive, a USB stick or a network share, so the backups survive if this PC&apos;s disk
                fails. The newest {status.keep} automatic backups are kept.
              </p>
              <div className="row" style={{ margin: '8px 0 12px' }}>
                <button className="btn" disabled={busy} onClick={() => void run(() => api.backup.now(), 'Backup saved.')} data-testid="backup-now">
                  BACK UP NOW
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.backup.pickDir(), 'Backup folder updated.')}>
                  CHANGE FOLDER
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => void pickRestore()}>
                  RESTORE FROM ANOTHER FOLDER…
                </button>
              </div>
              {status.backups.length > 0 && (
                <table className="table" data-testid="backup-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Tests</th>
                      <th>Size</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {status.backups.map((b) => (
                      <tr key={b.path}>
                        <td>{when(b.createdAt)}</td>
                        <td>{KIND_LABEL[b.kind]}</td>
                        <td>{b.testRuns ?? '?'}</td>
                        <td>{size(b.sizeBytes)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn ghost" style={{ height: 30 }} disabled={busy} onClick={() => setRestoring(b)}>
                            RESTORE
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          {message && <div className={`result ${message.ok ? 'ok' : 'bad'}`}>{message.text}</div>}
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            CLOSE
          </button>
        </div>
      </div>
      {restoring && (
        <div className="modal-backdrop">
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-head">Restore backup?</div>
            <div className="dialog-body">
              Replace <b>all</b> current data with the backup from <b>{when(restoring.createdAt)}</b>
              {restoring.testRuns !== null ? ` (${restoring.testRuns} tests)` : ''}? A backup of the current data is made first.
              The application restarts afterwards.
            </div>
            <div className="actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '0 18px 16px' }}>
              <button className="btn ghost" onClick={() => setRestoring(null)} disabled={busy}>
                CANCEL
              </button>
              <button className="btn danger" onClick={() => void restore(restoring)} disabled={busy}>
                RESTORE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
