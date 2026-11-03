import { useEffect, useState } from 'react'
import type { BackupInfo, BackupStatus } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

const KIND_LABEL: Record<BackupInfo['kind'], string> = {
  auto: 'Automatic',
  manual: 'Manual',
  'pre-restore': 'Before a restore'
}

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A backup older than this is flagged; automatic backups run daily. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000

export default function BackupPanel(): JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)

  const load = async (): Promise<void> => {
    const result = await api.backup.status()
    if (result.ok) setStatus(result.data)
    else toast.error(result.message)
  }

  useEffect(() => {
    void load()
  }, [])

  const run = async (action: () => Promise<{ ok: true; data: BackupStatus } | { ok: false; message: string }>, done: string): Promise<void> => {
    setBusy(true)
    const result = await action()
    setBusy(false)
    if (result.ok) {
      setStatus(result.data)
      toast.success(done)
    } else {
      toast.error(result.message)
    }
  }

  const pickRestore = async (): Promise<void> => {
    const result = await api.backup.pickRestore()
    if (!result.ok) toast.error(result.message)
    else if (result.data) setRestoring(result.data)
  }

  const restore = async (backup: BackupInfo): Promise<void> => {
    setBusy(true)
    const result = await api.backup.restore(backup.path)
    if (result.ok) {
      toast.success('Backup restored. PLTM HMI is restarting…')
    } else {
      setBusy(false)
      setRestoring(null)
      toast.error(result.message)
    }
  }

  if (!status) return <div className="panel orange">Loading…</div>

  const stale = !status.lastBackupAt || Date.now() - Date.parse(status.lastBackupAt) > STALE_MS

  return (
    <div className="panel orange backup-panel">
      <div className="section-title">
        <span className="glyph">&#128190;</span> BACKUP
      </div>
      <div className={stale || status.lastError ? 'hint warn' : 'hint'}>
        {status.lastError
          ? `The last backup failed: ${status.lastError}`
          : status.lastBackupAt
            ? `Last backup: ${when(status.lastBackupAt)}.`
            : 'No backup has been made yet.'}{' '}
        A backup is made automatically every day and holds all users, models, settings, test
        records, calibrations and attached certificate files.
      </div>
      <div className="field-row" style={{ marginTop: 8 }}>
        <label>BACKUP FOLDER</label>
        <div className="backup-dir" title={status.dir}>
          {status.dir}
        </div>
      </div>
      <div className="hint">
        Choose a folder on another drive, a USB stick or a network share, so the backups survive if
        this PC&apos;s disk fails. The newest {status.keep} automatic backups are kept.
      </div>
      <div className="row-actions" style={{ margin: '8px 0' }}>
        <button
          className="btn yellow small"
          disabled={busy}
          onClick={() => void run(() => api.backup.now(), 'Backup saved.')}
        >
          BACK UP NOW
        </button>
        <button
          className="btn small"
          disabled={busy}
          onClick={() => void run(() => api.backup.pickDir(), 'Backup folder updated.')}
        >
          CHANGE FOLDER
        </button>
        <button className="btn small" disabled={busy} onClick={() => void pickRestore()}>
          RESTORE FROM ANOTHER FOLDER…
        </button>
      </div>

      {status.backups.length > 0 && (
        <table className="cal-table backup-table">
          <thead>
            <tr>
              <th>DATE</th>
              <th>TYPE</th>
              <th>TESTS</th>
              <th>SIZE</th>
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
                <td className="row-actions">
                  <button className="btn small" disabled={busy} onClick={() => setRestoring(b)}>
                    RESTORE
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {restoring && (
        <div className="modal-backdrop">
          <div className="modal wide">
            <div className="modal-title">RESTORE BACKUP?</div>
            <div className="modal-inner left">
              <div>
                Replace <b>all</b> current data with the backup from{' '}
                <b>{when(restoring.createdAt)}</b>
                {restoring.testRuns !== null && <> ({restoring.testRuns} tests)</>}?
              </div>
              <div className="hint">
                Tests, calibrations and setting changes made after that time will no longer be
                shown. The current data is backed up first, so this can be undone by restoring that
                backup. PLTM HMI restarts when the restore is done.
              </div>
              <div className="row-actions">
                <button className="btn red" disabled={busy} onClick={() => void restore(restoring)}>
                  {busy ? 'RESTORING…' : 'RESTORE'}
                </button>
                <button className="btn" disabled={busy} onClick={() => setRestoring(null)}>
                  CANCEL
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
