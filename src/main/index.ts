import { join } from 'path'
import { app, BrowserWindow, dialog } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '@shared/types'
import { closeDb, initDb } from './db'
import { getHardware, initHardware } from './hardware/HardwareManager'
import { broadcast, registerIpcHandlers } from './ipc/handlers'
import { log } from './logger'
import { initTestService, onState, shutdown as shutdownTests } from './services/testService'

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
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#12263a',
    title: 'PantoCheck',
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
  hardware.on('state', (state) => broadcast(IPC.EVT_MACHINE, onState(state)))
}

function bootstrap(): void {
  process.on('uncaughtException', (error) => log.error('Uncaught exception', error))
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason))

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.pantocheck.app')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    try {
      initDb()
    } catch (error) {
      log.error('Database failed to open', error)
      dialog.showErrorBox(
        'PantoCheck cannot start',
        `The local database could not be opened.\n\n${error instanceof Error ? error.message : String(error)}`
      )
      app.exit(1)
      return
    }

    log.info(`Starting PantoCheck ${app.getVersion()}`)
    const hardware = initHardware()
    initTestService()
    registerIpcHandlers()
    wireHardwareEvents()
    // Connection failures are not fatal: the UI shows DISCONNECTED and the
    // supervisor keeps retrying.
    await hardware.tryConnect()
    hardware.startSupervision()

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
        shutdownTests()
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
