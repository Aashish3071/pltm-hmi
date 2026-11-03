import { join } from 'path'
import { app, BrowserWindow, dialog } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '@shared/types'
import { closeDb, initDb } from './db'
import { getHardware, initHardware } from './hardware/HardwareManager'
import { broadcast, onRunStatusChange, registerIpcHandlers } from './ipc/handlers'
import { log } from './logger'
import { latestRestorableBackup, restoreBackup, startAutoBackup, stopAutoBackup } from './services/backupService'
import { abortActiveRun, getActiveRunId, recordCycle, recordTelemetry } from './services/testRunService'

// Two instances would contend for the database and the machine's COM port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  bootstrap()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e293b',
    title: 'Pantograph Load Test Machine',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.on('ready-to-show', () => {
    window.maximize()
    window.show()
  })

  // The UI is entirely local; never navigate away or open other windows.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!(is.dev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))) {
      event.preventDefault()
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error(`Renderer process gone: ${details.reason}`)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function wireHardwareEvents(): void {
  const hardware = getHardware()
  hardware.on('telemetry', (frame) => {
    recordTelemetry(frame)
    broadcast(IPC.EVT_TELEMETRY, frame)
  })
  hardware.on('status', (status) => {
    onRunStatusChange(status)
    broadcast(IPC.EVT_STATUS, status)
  })
  hardware.on('connection', (event) => broadcast(IPC.EVT_CONNECTION, event))
  hardware.on('cycle-complete', (event) => {
    recordCycle(event.phase, event.elapsedSec)
    broadcast(IPC.EVT_CYCLE_COMPLETE, event)
  })
}

/**
 * Opens the database. If it is damaged, offers to restore the newest good
 * backup instead of leaving the machine unusable. Returns false to quit.
 */
function openDatabaseOrRecover(): boolean {
  try {
    initDb()
    return true
  } catch (error) {
    log.error('Database failed to open', error)
    const reason = error instanceof Error ? error.message : String(error)
    const backup = latestRestorableBackup()
    if (!backup) {
      dialog.showErrorBox(
        'PLTM HMI cannot start',
        `The local database could not be opened, and no backup was found to restore.\n\n${reason}`
      )
      return false
    }
    const when = new Date(backup.createdAt).toLocaleString()
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'PLTM HMI cannot start',
      message: 'The local database could not be opened.',
      detail:
        `${reason}\n\nThe newest backup is from ${when}` +
        (backup.testRuns !== null ? ` (${backup.testRuns} tests)` : '') +
        `.\nRestoring it replaces the damaged data; tests made after the backup are lost.\n\n${backup.path}`,
      buttons: ['Restore this backup', 'Quit'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice !== 0) return false
    try {
      restoreBackup(backup.path)
      initDb()
      log.info(`Recovered from backup ${backup.path} at startup`)
      return true
    } catch (restoreError) {
      log.error('Startup restore failed', restoreError)
      dialog.showErrorBox('Restore failed', String(restoreError instanceof Error ? restoreError.message : restoreError))
      return false
    }
  }
}

function bootstrap(): void {
  process.on('uncaughtException', (error) => log.error('Uncaught exception', error))
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason))

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.novatek.pltm')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    if (!openDatabaseOrRecover()) {
      app.exit(1)
      return
    }

    log.info(`Starting PLTM HMI ${app.getVersion()}`)
    const hardware = initHardware()
    registerIpcHandlers()
    wireHardwareEvents()
    // Connection failures are not fatal: the UI shows DISCONNECTED and the
    // supervisor keeps retrying.
    await hardware.tryConnect()
    hardware.startSupervision()
    startAutoBackup(() => getActiveRunId() !== null)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let shuttingDown = false
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    void (async () => {
      try {
        stopAutoBackup()
        await abortActiveRun()
        const hardware = getHardware()
        hardware.stopSupervision()
        await hardware.disconnect()
      } catch (error) {
        log.error('Error during shutdown', error)
      } finally {
        closeDb()
        app.quit()
      }
    })()
  })
}
